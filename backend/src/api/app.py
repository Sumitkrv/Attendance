import os
import math
import re
import random
import shutil
import threading
import uuid
import time
import json
import logging
import hashlib
from datetime import datetime, timedelta
from pathlib import Path
from bson import json_util
from bson.binary import Binary
from typing import Optional
from urllib.parse import urlparse

import cv2
import numpy as np
import face_recognition
from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, render_template_string, redirect
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from pymongo import MongoClient
from pymongo.errors import PyMongoError, ServerSelectionTimeoutError
from werkzeug.exceptions import HTTPException
from werkzeug.exceptions import RequestEntityTooLarge

from src.attendance.attendance_manager import AttendanceManager
from src.recognize_faces import FaceRecognizer
from src.security import (
    admin_auth_required,
    build_password_hash,
    get_token_policy,
    issue_admin_token,
    issue_user_token,
    refresh_admin_token,
    refresh_user_token,
    user_auth_required,
    verify_admin_credentials,
)
from werkzeug.security import check_password_hash
from src.train_model import ModelTrainer
from src.utils.helpers import ensure_dir, is_image_file, slugify_name

try:
    import mongomock
except Exception:
    mongomock = None

try:
    import redis
except Exception:
    redis = None

try:
    import sentry_sdk
    from sentry_sdk.integrations.flask import FlaskIntegration
except Exception:
    sentry_sdk = None
    FlaskIntegration = None

BASE_DIR = Path(__file__).resolve().parents[2]


def _load_environment():
    env_aliases = {
        "development": "dev",
        "dev": "dev",
        "staging": "staging",
        "production": "prod",
        "prod": "prod",
    }

    requested_env = str(os.getenv("APP_ENV") or os.getenv("FLASK_ENV") or "dev").strip().lower()
    app_env = env_aliases.get(requested_env, requested_env)
    explicit_env_file = str(os.getenv("ENV_FILE", "")).strip()

    candidate_files = []
    if explicit_env_file:
        explicit_path = Path(explicit_env_file)
        candidate_files.append(explicit_path if explicit_path.is_absolute() else BASE_DIR / explicit_path)
    else:
        candidate_files.append(BASE_DIR / f".env.{app_env}")
        candidate_files.append(BASE_DIR / ".env")

    loaded_from = None
    for env_path in candidate_files:
        if env_path.exists():
            load_dotenv(dotenv_path=env_path, override=False)
            loaded_from = str(env_path)
            break

    if loaded_from is None:
        load_dotenv(override=False)

    return app_env, loaded_from


APP_ENV, LOADED_ENV_FILE = _load_environment()
DISABLE_BACKEND_UI = str(os.getenv("DISABLE_BACKEND_UI", "true")).strip().lower() in {"1", "true", "yes", "on"}
FRONTEND_APP_BASE_URL = str(os.getenv("FRONTEND_APP_BASE_URL", "http://127.0.0.1:5173")).strip().rstrip("/")


class JsonLogFormatter(logging.Formatter):
    def format(self, record):
        payload = {
            "ts": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key in (
            "event",
            "request_id",
            "method",
            "path",
            "status",
            "duration_ms",
            "remote_addr",
            "app_env",
        ):
            val = getattr(record, key, None)
            if val is not None:
                payload[key] = val
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def _setup_logging():
    root = logging.getLogger()
    if root.handlers:
        for h in root.handlers:
            h.setFormatter(JsonLogFormatter())
    else:
        handler = logging.StreamHandler()
        handler.setFormatter(JsonLogFormatter())
        root.addHandler(handler)

    level_name = str(os.getenv("LOG_LEVEL", "INFO")).upper()
    level = getattr(logging, level_name, logging.INFO)
    root.setLevel(level)


_setup_logging()
logger = logging.getLogger("attendance.api")


def _setup_sentry():
    dsn = str(os.getenv("SENTRY_DSN", "")).strip()
    if not dsn or sentry_sdk is None or FlaskIntegration is None:
        return False

    traces_sample_rate_raw = str(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1")).strip() or "0.1"
    try:
        traces_sample_rate = float(traces_sample_rate_raw)
    except ValueError:
        traces_sample_rate = 0.1

    sentry_sdk.init(
        dsn=dsn,
        integrations=[FlaskIntegration()],
        environment=APP_ENV,
        traces_sample_rate=max(0.0, min(1.0, traces_sample_rate)),
        send_default_pii=False,
    )
    return True


SENTRY_ENABLED = _setup_sentry()


def _validate_required_prod_env():
    if APP_ENV not in {"prod", "production"}:
        return

    missing = []

    for key in ("SECRET_KEY", "MONGODB_URI", "ALLOWED_ORIGINS"):
        if not str(os.getenv(key, "")).strip():
            missing.append(key)

    secret_key = str(os.getenv("SECRET_KEY", "")).strip()
    if secret_key in {"", "dev-secret-change-me", "change-this-in-production"}:
        missing.append("SECRET_KEY(non-default)")

    admin_user = str(os.getenv("ADMIN_USERNAME", "")).strip()
    admin_hash = str(os.getenv("ADMIN_PASSWORD_HASH", "")).strip()
    if not admin_user or not admin_hash:
        missing.append("ADMIN_USERNAME + ADMIN_PASSWORD_HASH")

    for key in ("OFFICE_LAT", "OFFICE_LNG", "OFFICE_RADIUS_METERS"):
        if not str(os.getenv(key, "")).strip():
            missing.append(key)

    if missing:
        raise RuntimeError(f"Missing required production environment variables: {', '.join(missing)}")


_validate_required_prod_env()

app = Flask(__name__)

allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5001").split(",")
    if origin.strip()
]
CORS(app, resources={r"/*": {"origins": allowed_origins}})

max_upload_mb = float(os.getenv("MAX_CONTENT_LENGTH_MB", "10"))
app.config["MAX_CONTENT_LENGTH"] = int(max_upload_mb * 1024 * 1024)

rate_limit_storage_uri = str(os.getenv("RATE_LIMIT_STORAGE_URI", "memory://")).strip() or "memory://"
sync_model_artifact = str(
    os.getenv("SYNC_MODEL_ARTIFACT", "true" if APP_ENV in {"prod", "staging"} else "false")
).strip().lower() in {"1", "true", "yes", "on"}
model_artifact_max_mb = max(1.0, float(os.getenv("MODEL_ARTIFACT_MAX_MB", "14")))
MODEL_ARTIFACT_KEY = "trained_model_artifact"
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["5000 per hour", "300 per minute"],
    storage_uri=rate_limit_storage_uri,
)
DATASET_PATH = BASE_DIR / os.getenv("DATASET_PATH", "../persistent/dataset")
MODEL_PATH = BASE_DIR / os.getenv("MODEL_PATH", "../persistent/models/face_encodings.pkl")
MANUAL_REQUESTS_IMAGE_DIR = BASE_DIR / os.getenv("MANUAL_REQUESTS_IMAGE_DIR", "../persistent/manual_requests")

ensure_dir(DATASET_PATH)
ensure_dir(MODEL_PATH.parent)
ensure_dir(MANUAL_REQUESTS_IMAGE_DIR)

mongo_uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
db_name = os.getenv("MONGODB_DB", "face_attendance")
MOCK_DB_DUMP_PATH = BASE_DIR / os.getenv("MOCK_DB_DUMP_PATH", "../persistent/models/mock_db_dump.json")
use_mock_requested = str(os.getenv("USE_MOCK_DB", "false")).lower() in {"1", "true", "yes", "on"}
allow_mock_db = str(os.getenv("ALLOW_MOCK_DB", "false")).lower() in {"1", "true", "yes", "on"}
use_mock = bool(use_mock_requested and allow_mock_db)
mock_db_persist = str(os.getenv("MOCK_DB_PERSIST", "true")).lower() in {"1", "true", "yes", "on"}
mock_db_reset_on_start = str(os.getenv("MOCK_DB_RESET_ON_START", "false")).lower() in {"1", "true", "yes", "on"}

using_mock_db = False
if use_mock:
    if mongomock is None:
        raise RuntimeError("USE_MOCK_DB is true but mongomock is not installed")
    mongo_client = mongomock.MongoClient()
    using_mock_db = True
else:
    mongo_client = MongoClient(mongo_uri, serverSelectionTimeoutMS=2000)
    try:
        mongo_client.admin.command("ping")
    except (ServerSelectionTimeoutError, PyMongoError):
        raise RuntimeError(
            "Could not connect to MongoDB. Set USE_MOCK_DB=true for local mock mode or fix MONGODB_URI."
        )

db = mongo_client[db_name]
db.audit_logs.create_index([("created_at", -1)])
validate_enrollment_faces = str(os.getenv("VALIDATE_ENROLLMENT_FACES", "true")).lower() in {"1", "true", "yes", "on"}
min_enrollment_images = int(os.getenv("MIN_ENROLLMENT_IMAGES", "3"))
allow_credentials_only_enrollment = str(
    os.getenv(
        "ALLOW_CREDENTIALS_ONLY_ENROLLMENT",
        "true" if APP_ENV in {"dev", "development"} else "false",
    )
).lower() in {"1", "true", "yes", "on"}
enable_office_geofence = str(os.getenv("ENABLE_OFFICE_GEOFENCE", "true")).lower() in {"1", "true", "yes", "on"}
force_office_geofence = str(os.getenv("FORCE_OFFICE_GEOFENCE", "false")).lower() in {"1", "true", "yes", "on"}
min_password_length = max(6, int(os.getenv("MIN_PASSWORD_LENGTH", "8")))
require_password_mix = str(os.getenv("REQUIRE_PASSWORD_MIX", "true")).lower() in {"1", "true", "yes", "on"}


def _validate_password_policy(password: str, label: str = "Password") -> Optional[str]:
    text = str(password or "")
    if len(text) < min_password_length:
        return f"{label} must be at least {min_password_length} characters"

    if require_password_mix:
        has_letter = bool(re.search(r"[A-Za-z]", text))
        has_digit = bool(re.search(r"\d", text))
        if not (has_letter and has_digit):
            return f"{label} must include both letters and numbers"

    return None


def _validate_login_id(login_id: str) -> Optional[str]:
    value = str(login_id or "").strip().lower()
    if not value:
        return "Login ID is required"
    if len(value) < 3 or len(value) > 32:
        return "Login ID must be between 3 and 32 characters"
    if not re.fullmatch(r"[a-z0-9._-]+", value):
        return "Login ID can contain only lowercase letters, numbers, dot, underscore, and hyphen"
    return None


def _validate_department(department: str) -> Optional[str]:
    value = str(department or "General").strip()
    if not value:
        return "Department is required"
    if len(value) > 64:
        return "Department must be at most 64 characters"
    return None


@app.after_request
def _set_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(self), geolocation=(self)")
    response.headers.setdefault("Cache-Control", "no-store")

    start_ts = getattr(g, "request_start_ts", None)
    if start_ts is not None:
        duration_ms = round((time.perf_counter() - start_ts) * 1000.0, 2)
        response.headers.setdefault("X-Request-ID", str(getattr(g, "request_id", "")))
        logger.info(
            "http_request",
            extra={
                "event": "http_request",
                "request_id": getattr(g, "request_id", None),
                "method": request.method,
                "path": request.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
                "remote_addr": request.headers.get("X-Forwarded-For", request.remote_addr),
                "app_env": APP_ENV,
            },
        )
    return response


@app.before_request
def _request_observability_context():
    g.request_start_ts = time.perf_counter()
    rid = request.headers.get("X-Request-ID", "").strip()
    g.request_id = rid if rid else uuid.uuid4().hex


@app.before_request
def _disable_legacy_backend_ui_routes():
    if not DISABLE_BACKEND_UI:
        return None
    if request.method not in {"GET", "HEAD"}:
        return None

    path = request.path or ""
    if path not in {"/", "/admin", "/user"}:
        return None

    redirect_map = {
        "/": FRONTEND_APP_BASE_URL,
        "/admin": f"{FRONTEND_APP_BASE_URL}/#/admin",
        "/user": f"{FRONTEND_APP_BASE_URL}/#/user",
    }
    return redirect(redirect_map[path], code=302)


def _env_float(name: str, default=None):
    raw = os.getenv(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


office_lat = _env_float("OFFICE_LAT", None)
office_lng = _env_float("OFFICE_LNG", None)
office_radius_meters = _env_float("OFFICE_RADIUS_METERS", 500.0)
scan_challenge_ttl_seconds = int(os.getenv("SCAN_CHALLENGE_TTL_SECONDS", "18"))
scan_challenge_lock = threading.Lock()
scan_challenges = {}

mock_persist_lock = threading.Lock()


def _cleanup_scan_challenges(now: Optional[datetime] = None):
    current = now or datetime.now()
    expired = [key for key, val in scan_challenges.items() if val.get("expires_at") <= current]
    for key in expired:
        scan_challenges.pop(key, None)


def _issue_scan_challenge(claims: dict) -> dict:
    now = datetime.now()
    action = random.choice(["blink_and_turn", "turn", "blink"])
    if action == "blink_and_turn":
        instruction = "Blink once and turn your head slightly"
    elif action == "turn":
        instruction = "Turn your head slightly left or right"
    else:
        instruction = "Blink naturally"

    challenge_id = uuid.uuid4().hex
    payload = {
        "challenge_id": challenge_id,
        "action": action,
        "instruction": instruction,
        "employee_name": claims.get("employee_name"),
        "login_id": claims.get("login_id"),
        "expires_at": now + timedelta(seconds=max(8, scan_challenge_ttl_seconds)),
    }

    with scan_challenge_lock:
        _cleanup_scan_challenges(now)
        scan_challenges[challenge_id] = payload

    return {
        "challenge_id": challenge_id,
        "action": action,
        "instruction": instruction,
        "expires_in_seconds": max(8, scan_challenge_ttl_seconds),
    }


def _consume_scan_challenge(challenge_id: str, claims: dict):
    now = datetime.now()
    with scan_challenge_lock:
        _cleanup_scan_challenges(now)
        item = scan_challenges.pop(challenge_id, None)

    if not item:
        return {"ok": False, "code": 400, "status": "invalid_challenge", "message": "Challenge expired. Please scan again"}

    if item.get("expires_at") <= now:
        return {"ok": False, "code": 400, "status": "invalid_challenge", "message": "Challenge expired. Please scan again"}

    if (item.get("employee_name") or "") != (claims.get("employee_name") or ""):
        return {"ok": False, "code": 403, "status": "invalid_challenge", "message": "Challenge does not match this user"}

    if (item.get("login_id") or "") != (claims.get("login_id") or ""):
        return {"ok": False, "code": 403, "status": "invalid_challenge", "message": "Challenge does not match this session"}

    return {"ok": True, "action": item.get("action"), "instruction": item.get("instruction")}


def _haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius * c


def _validate_scan_location():
    geofence_active = bool(enable_office_geofence) or bool(force_office_geofence)
    if not geofence_active:
        return {
            "enabled": False,
            "ok": False,
            "code": 403,
            "status": "geofence_disabled",
            "message": "Location verification is disabled by admin. Enable geofence in admin settings to mark attendance.",
        }

    if office_lat is None or office_lng is None:
        return {
            "enabled": True,
            "ok": False,
            "code": 500,
            "status": "geofence_not_configured",
            "message": "Office location is not configured",
        }

    lat_raw = request.form.get("lat")
    lng_raw = request.form.get("lng")
    if lat_raw is None or lng_raw is None:
        return {
            "enabled": True,
            "ok": False,
            "code": 400,
            "status": "location_required",
            "message": "Location is required for attendance",
        }

    try:
        lat = float(lat_raw)
        lng = float(lng_raw)
    except (TypeError, ValueError):
        return {
            "enabled": True,
            "ok": False,
            "code": 400,
            "status": "invalid_location",
            "message": "Invalid location coordinates",
        }

    if lat < -90 or lat > 90 or lng < -180 or lng > 180:
        return {
            "enabled": True,
            "ok": False,
            "code": 400,
            "status": "invalid_location",
            "message": "Invalid location range",
        }

    distance_m = _haversine_meters(lat, lng, office_lat, office_lng)
    allowed_radius_m = float(office_radius_meters or 500.0)

    try:
        accuracy = float(request.form.get("accuracy", "0") or 0)
    except (TypeError, ValueError):
        accuracy = 0.0

    # GPS can drift, especially indoors. Add an accuracy grace window.
    # We cap grace to avoid very large spoof-friendly allowances.
    effective_radius_m = allowed_radius_m + min(max(accuracy, 0.0), 200.0)

    if distance_m > effective_radius_m:
        return {
            "enabled": True,
            "ok": False,
            "code": 403,
            "status": "outside_office",
            "message": (
                f"Outside office location. Distance {round(distance_m, 1)}m, "
                f"allowed {round(allowed_radius_m, 1)}m (+accuracy {round(min(max(accuracy, 0.0), 200.0), 1)}m)."
            ),
            "distance_m": round(distance_m, 2),
            "allowed_radius_m": round(allowed_radius_m, 2),
            "effective_radius_m": round(effective_radius_m, 2),
            "accuracy_m": round(accuracy, 2),
        }

    return {
        "enabled": True,
        "ok": True,
        "distance_m": round(distance_m, 2),
        "allowed_radius_m": round(allowed_radius_m, 2),
        "effective_radius_m": round(effective_radius_m, 2),
        "accuracy_m": round(accuracy, 2),
    }


def persist_mock_db_now():
    if not using_mock_db or not mock_db_persist:
        return

    with mock_persist_lock:
        payload = {
            "employees": list(db.employees.find()),
            "attendance": list(db.attendance.find()),
            "settings": list(db.settings.find()),
            "manual_requests": list(db.manual_requests.find()),
            "audit_logs": list(db.audit_logs.find().sort("created_at", -1).limit(1000)),
            "saved_at": datetime.now(),
        }
        ensure_dir(MOCK_DB_DUMP_PATH.parent)
        tmp_path = MOCK_DB_DUMP_PATH.with_suffix(".json.tmp")
        tmp_path.write_text(json_util.dumps(payload), encoding="utf-8")
        tmp_path.replace(MOCK_DB_DUMP_PATH)


def load_mock_db_dump():
    if not using_mock_db:
        return

    if mock_db_reset_on_start:
        db.employees.delete_many({})
        db.attendance.delete_many({})
        db.settings.delete_many({})
        db.manual_requests.delete_many({})
        db.audit_logs.delete_many({})
        if MOCK_DB_DUMP_PATH.exists():
            try:
                MOCK_DB_DUMP_PATH.unlink()
            except Exception:
                pass
        return

    if not mock_db_persist or not MOCK_DB_DUMP_PATH.exists():
        return
    try:
        payload = json_util.loads(MOCK_DB_DUMP_PATH.read_text(encoding="utf-8"))
        employees = payload.get("employees", [])
        attendance = payload.get("attendance", [])
        settings = payload.get("settings", [])
        manual_requests = payload.get("manual_requests", [])
        audit_logs = payload.get("audit_logs", [])

        db.employees.delete_many({})
        db.attendance.delete_many({})
        db.settings.delete_many({})
        db.manual_requests.delete_many({})
        db.audit_logs.delete_many({})
        if employees:
            db.employees.insert_many(employees)
        if attendance:
            db.attendance.insert_many(attendance)
        if settings:
            db.settings.insert_many(settings)
        if manual_requests:
            db.manual_requests.insert_many(manual_requests)
        if audit_logs:
            db.audit_logs.insert_many(audit_logs)
    except Exception:
        pass


def log_audit(action: str, status: str = "success", target: Optional[dict] = None, details: Optional[dict] = None):
    actor_role = "system"
    actor_id = "system"
    actor_name = "system"

    try:
        admin_claims = getattr(g, "admin_claims", None) or {}
        user_claims = getattr(g, "user_claims", None) or {}

        if admin_claims:
            actor_role = "admin"
            actor_name = admin_claims.get("sub") or "admin"
            actor_id = actor_name
        elif user_claims:
            actor_role = "user"
            actor_name = user_claims.get("employee_name") or user_claims.get("login_id") or "user"
            actor_id = user_claims.get("employee_id") or user_claims.get("sub") or actor_name
    except Exception:
        pass

    payload = {
        "action": action,
        "status": status,
        "actor_role": actor_role,
        "actor_id": str(actor_id),
        "actor_name": str(actor_name),
        "target": target or {},
        "details": details or {},
        "created_at": datetime.now(),
    }

    try:
        db.audit_logs.insert_one(payload)
        persist_mock_db_now()
    except Exception:
        pass


def _serialize_manual_request(row: dict) -> dict:
    item = dict(row)
    item["id"] = str(item.pop("_id"))

    for key in ("created_at", "updated_at", "approved_at", "rejected_at"):
        value = item.get(key)
        if isinstance(value, datetime):
            item[key] = value.isoformat()

    return item


def _to_bool(value, default=False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def _to_optional_float(value):
    if value is None:
        return None
    if isinstance(value, str) and value.strip() == "":
        return None
    return float(value)


def _current_geofence_settings() -> dict:
    return {
        "enabled": bool(enable_office_geofence),
        "office_lat": office_lat,
        "office_lng": office_lng,
        "office_radius_meters": float(office_radius_meters or 500.0),
    }


def _load_geofence_settings_from_db():
    global enable_office_geofence, office_lat, office_lng, office_radius_meters

    doc = db.settings.find_one({"key": "geofence"}) or {}
    value = doc.get("value") or {}
    if not isinstance(value, dict) or not value:
        return

    try:
        enable_office_geofence = _to_bool(value.get("enabled"), enable_office_geofence)
        loaded_lat = _to_optional_float(value.get("office_lat"))
        loaded_lng = _to_optional_float(value.get("office_lng"))
        loaded_radius = _to_optional_float(value.get("office_radius_meters"))

        office_lat = loaded_lat if loaded_lat is not None else office_lat
        office_lng = loaded_lng if loaded_lng is not None else office_lng
        if loaded_radius is not None and loaded_radius > 0:
            office_radius_meters = float(loaded_radius)
    except Exception:
        pass


def _persist_geofence_settings():
    db.settings.update_one(
        {"key": "geofence"},
        {
            "$set": {
                "key": "geofence",
                "value": _current_geofence_settings(),
                "updated_at": datetime.now(),
            }
        },
        upsert=True,
    )
    persist_mock_db_now()


def _persist_recognition_settings():
    db.settings.update_one(
        {"key": "recognition"},
        {
            "$set": {
                "key": "recognition",
                "value": face_recognizer.get_settings(),
                "updated_at": datetime.now(),
            }
        },
        upsert=True,
    )
    persist_mock_db_now()


def _persist_model_artifact_to_db() -> bool:
    if not sync_model_artifact:
        return False

    try:
        if not MODEL_PATH.exists() or MODEL_PATH.stat().st_size <= 0:
            return False

        size_bytes = int(MODEL_PATH.stat().st_size)
        max_bytes = int(model_artifact_max_mb * 1024 * 1024)
        if size_bytes > max_bytes:
            logger.warning(
                "model_artifact_skip_large",
                extra={
                    "event": "model_artifact_skip_large",
                    "size_bytes": size_bytes,
                    "max_bytes": max_bytes,
                },
            )
            return False

        payload = MODEL_PATH.read_bytes()
        sha256 = hashlib.sha256(payload).hexdigest()
        db.settings.update_one(
            {"key": MODEL_ARTIFACT_KEY},
            {
                "$set": {
                    "key": MODEL_ARTIFACT_KEY,
                    "value": {
                        "filename": MODEL_PATH.name,
                        "size_bytes": size_bytes,
                        "sha256": sha256,
                        "blob": Binary(payload),
                    },
                    "updated_at": datetime.now(),
                }
            },
            upsert=True,
        )
        persist_mock_db_now()
        return True
    except Exception as exc:
        logger.warning(
            "model_artifact_persist_failed",
            extra={
                "event": "model_artifact_persist_failed",
                "error": str(exc),
            },
        )
        return False


def _restore_model_artifact_from_db_if_missing() -> bool:
    if not sync_model_artifact:
        return False

    try:
        if MODEL_PATH.exists() and MODEL_PATH.stat().st_size > 0:
            return False
    except Exception:
        pass

    try:
        doc = db.settings.find_one({"key": MODEL_ARTIFACT_KEY}) or {}
        value = doc.get("value") or {}
        blob = value.get("blob")
        if blob is None:
            return False

        raw = bytes(blob)
        if not raw:
            return False

        ensure_dir(MODEL_PATH.parent)
        tmp_path = MODEL_PATH.with_suffix(MODEL_PATH.suffix + ".tmp")
        tmp_path.write_bytes(raw)
        tmp_path.replace(MODEL_PATH)
        return True
    except Exception as exc:
        logger.warning(
            "model_artifact_restore_failed",
            extra={
                "event": "model_artifact_restore_failed",
                "error": str(exc),
            },
        )
        return False


def _sync_model_artifact_on_boot():
    if not sync_model_artifact:
        return

    restored = _restore_model_artifact_from_db_if_missing()
    if restored:
        logger.info("model_artifact_restored", extra={"event": "model_artifact_restored"})
        return

    persisted = _persist_model_artifact_to_db()
    if persisted:
        logger.info("model_artifact_persisted", extra={"event": "model_artifact_persisted"})


def _load_recognition_settings_from_db():
    doc = db.settings.find_one({"key": "recognition"}) or {}
    value = doc.get("value") or {}
    if not isinstance(value, dict) or not value:
        return

    try:
        face_recognizer.apply_settings(value)
    except Exception:
        pass


def _bootstrap_employee_credentials():
    default_password = str(os.getenv("DEFAULT_EMPLOYEE_PASSWORD", "") or "").strip()
    if _validate_password_policy(default_password, label="Default password"):
        default_password = "Temp#{}{}".format(uuid.uuid4().hex[:5], uuid.uuid4().hex[:3])
    changed = False
    now = datetime.now()

    rows = list(db.employees.find())
    seen_login_ids = set()
    for row in rows:
        login_id = (row.get("login_id") or "").strip().lower()
        if not login_id:
            base = slugify_name(row.get("name") or "employee")
            candidate = base
            i = 1
            while candidate in seen_login_ids or db.employees.find_one({"login_id": candidate, "_id": {"$ne": row.get("_id")}}):
                i += 1
                candidate = f"{base}{i}"
            login_id = candidate

        update = {}
        unset_fields = {}
        if row.get("login_id") != login_id:
            update["login_id"] = login_id

        if not (row.get("password_hash") or "").strip():
            update["password_hash"] = build_password_hash(default_password)
            update["must_change_password"] = True
            update["password_updated_by"] = "admin"
            update["password_updated_at"] = now

        if "password_visible_for_admin" in row:
            unset_fields["password_visible_for_admin"] = ""

        if "must_change_password" not in row:
            update["must_change_password"] = True

        if "password_updated_by" not in row:
            update["password_updated_by"] = "admin" if bool(row.get("must_change_password", True)) else "user"

        if "password_updated_at" not in row:
            update["password_updated_at"] = row.get("updated_at") or now

        if update or unset_fields:
            if update:
                update["updated_at"] = datetime.now()
            patch = {}
            if update:
                patch["$set"] = update
            if unset_fields:
                patch["$unset"] = unset_fields
            db.employees.update_one({"_id": row["_id"]}, patch)
            changed = True

        seen_login_ids.add(login_id)

    if changed:
        persist_mock_db_now()

load_mock_db_dump()
_load_geofence_settings_from_db()
_bootstrap_employee_credentials()
_sync_model_artifact_on_boot()
attendance_manager = AttendanceManager(db, on_change=persist_mock_db_now)
face_recognizer = FaceRecognizer(attendance_manager=attendance_manager, model_path=str(MODEL_PATH))
_load_recognition_settings_from_db()

train_lock = threading.Lock()
train_state = {
    "job_id": None,
    "running": False,
    "progress": 0,
    "message": "Idle",
    "status": "idle",
    "result": None,
    "error": None,
    "updated_at": datetime.now().isoformat(),
}


def _update_train_state(**kwargs):
    with train_lock:
        train_state.update(kwargs)
        train_state["updated_at"] = datetime.now().isoformat()


def _run_training_job(job_id: str):
    _update_train_state(
        job_id=job_id,
        running=True,
        progress=0,
        message="Starting training",
        status="running",
        result=None,
        error=None,
    )

    def progress_callback(processed: int, total: int, message: str):
        progress = int((processed / total) * 100) if total else 0
        _update_train_state(progress=progress, message=message, status="running")

    try:
        trainer = ModelTrainer(str(DATASET_PATH), str(MODEL_PATH))
        result = trainer.train(progress_callback=progress_callback)
        _persist_model_artifact_to_db()
        _update_train_state(
            running=False,
            progress=100,
            message="Training completed",
            status="completed",
            result=result,
            error=None,
        )
    except Exception as exc:
        _update_train_state(
            running=False,
            status="failed",
            message="Training failed",
            error=str(exc),
        )


def _start_training_if_idle() -> Optional[str]:
    with train_lock:
        if train_state.get("running"):
            return None

    job_id = str(uuid.uuid4())
    worker = threading.Thread(target=_run_training_job, args=(job_id,), daemon=True)
    worker.start()
    return job_id


@app.get("/health")
def health_check():
    deps = _dependency_health()
    return jsonify(
        {
            "status": "ok",
            "time": datetime.now().isoformat(),
            "app_env": APP_ENV,
            "db_mode": "mock" if using_mock_db else "mongo",
            "db_name": db_name,
            "env_file": LOADED_ENV_FILE,
            "mock_db_persist": bool(mock_db_persist) if using_mock_db else None,
            "mock_db_reset_on_start": bool(mock_db_reset_on_start) if using_mock_db else None,
            "rate_limit_storage_uri": rate_limit_storage_uri,
            "sentry_enabled": bool(SENTRY_ENABLED),
            "dependencies": deps,
        }
    )


def _dependency_health():
    deps = {
        "mongo": {"ok": False, "detail": "uninitialized"},
        "redis": {"ok": None, "detail": "not_configured"},
    }

    try:
        if using_mock_db:
            deps["mongo"] = {"ok": True, "detail": "mock"}
        else:
            mongo_client.admin.command("ping")
            deps["mongo"] = {"ok": True, "detail": "ping_ok"}
    except Exception as exc:
        deps["mongo"] = {"ok": False, "detail": str(exc)}

    parsed = urlparse(rate_limit_storage_uri)
    if parsed.scheme.startswith("redis"):
        if redis is None:
            deps["redis"] = {"ok": False, "detail": "redis package missing"}
        else:
            try:
                client = redis.from_url(rate_limit_storage_uri, socket_timeout=1, socket_connect_timeout=1)
                pong = client.ping()
                deps["redis"] = {"ok": bool(pong), "detail": "ping_ok" if pong else "ping_failed"}
            except Exception as exc:
                deps["redis"] = {"ok": False, "detail": str(exc)}

    return deps


@app.get("/ready")
def readiness_check():
    deps = _dependency_health()
    mongo_ok = bool((deps.get("mongo") or {}).get("ok"))
    redis_state = (deps.get("redis") or {}).get("ok")
    redis_ok = True if redis_state is None else bool(redis_state)
    ready = bool(mongo_ok and redis_ok)
    return (
        jsonify(
            {
                "status": "ready" if ready else "not_ready",
                "app_env": APP_ENV,
                "dependencies": deps,
            }
        ),
        200 if ready else 503,
    )


@app.get("/security/token_policy")
@admin_auth_required
def security_token_policy():
    policy = get_token_policy()
    return jsonify(
        {
            "admin_expires_min": int(policy.get("admin_expires_min", 0)),
            "user_expires_min": int(policy.get("user_expires_min", 0)),
        }
    )


@app.get("/")
def home_page():
    return render_template_string(
        """
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Face Attendance</title>
    <style>
        :root {
            --bg: #0b1020;
            --card: #121a31;
            --text: #ebf0ff;
            --muted: #9fb0d8;
            --accent: #5b8cff;
            --accent-2: #39d0ff;
            --ok: #24c38a;
            --border: #273559;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
            color: var(--text);
            background: radial-gradient(1200px 700px at 10% -10%, #22315f 0%, var(--bg) 45%), var(--bg);
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
        }
        .wrap { width: 100%; max-width: 920px; }
        .hero {
            border: 1px solid var(--border);
            background: linear-gradient(145deg, #0f1730, #111a34);
            border-radius: 18px;
            padding: 26px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
        }
        .badge {
            display: inline-block;
            padding: 6px 10px;
            border-radius: 999px;
            border: 1px solid #2f4270;
            color: var(--muted);
            font-size: 12px;
            margin-bottom: 10px;
        }
        h1 { margin: 0 0 10px 0; font-size: clamp(24px, 3vw, 34px); }
        p { margin: 0; color: var(--muted); }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 14px;
            margin-top: 18px;
        }
        .card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 14px;
            padding: 16px;
        }
        .card h3 { margin: 0 0 8px 0; }
        .card p { margin-bottom: 14px; }
        .btn {
            display: inline-block;
            text-decoration: none;
            border: 1px solid #3a4f85;
            background: linear-gradient(145deg, var(--accent), var(--accent-2));
            color: white;
            font-weight: 600;
            padding: 10px 14px;
            border-radius: 10px;
        }
        .btn.secondary {
            background: transparent;
            color: #bfd0ff;
        }
        ul { margin: 14px 0 0 20px; color: var(--muted); }
        .ok { color: var(--ok); font-weight: 600; }
    </style>
</head>
<body>
    <main class="wrap">
        <section class="hero">
            <span class="badge">Production-ready Face Attendance</span>
            <h1>Welcome to Smart Attendance</h1>
            <p>Fast login, cleaner UI, and direct access to admin and employee workflows.</p>

            <div class="grid">
                <article class="card">
                    <h3>Admin Portal</h3>
                    <p>Manage employees, inspect attendance, and monitor training status.</p>
                    <a class="btn" href="/admin">Open Admin Login</a>
                </article>

                <article class="card">
                    <h3>User Portal</h3>
                    <p>Secure employee login, password change support, and attendance scan API access.</p>
                    <a class="btn" href="/user">Open User Login</a>
                </article>

                <article class="card">
                    <h3>System Health</h3>
                    <p>Verify backend environment and database mode instantly.</p>
                    <a class="btn secondary" href="/health">Open Health Check</a>
                </article>
            </div>

            <ul>
                <li><span class="ok">Live-ready:</span> secure headers, JWT auth, and rate-limited endpoints.</li>
                <li><span class="ok">UX improved:</span> modern responsive UI with clear login feedback.</li>
            </ul>
        </section>
    </main>
</body>
</html>
        """
    )


@app.get("/admin")
def admin_login_page():
    show_dev_password_hint = APP_ENV in {"dev", "development"}
    return render_template_string(
        """
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Admin Portal</title>
    <style>
        :root {
            --bg: #f4f7ff;
            --card: #ffffff;
            --text: #12203e;
            --muted: #5f6f94;
            --border: #dbe4ff;
            --primary: #355cff;
            --danger: #d94f70;
            --ok: #1f9f73;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
            color: var(--text);
            background: linear-gradient(180deg, #eef3ff 0%, #f8fbff 100%);
            min-height: 100vh;
            padding: 22px;
        }
        .wrap { max-width: 1080px; margin: 0 auto; }
        .panel {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 18px;
            box-shadow: 0 14px 30px rgba(35, 62, 125, 0.08);
            margin-bottom: 14px;
        }
        h1, h2, h3 { margin: 0 0 8px 0; }
        p { margin: 0; color: var(--muted); }
        .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
        input, button {
            width: 100%;
            padding: 11px 12px;
            border-radius: 10px;
            border: 1px solid var(--border);
            font-size: 14px;
        }
        button {
            background: var(--primary);
            color: #fff;
            border-color: var(--primary);
            font-weight: 600;
            cursor: pointer;
        }
        button.secondary { background: white; color: var(--text); }
        button.ghost { background: transparent; color: var(--muted); }
        button:disabled { opacity: 0.6; cursor: not-allowed; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; }
        .status {
            margin-top: 8px;
            border-radius: 10px;
            padding: 10px;
            font-size: 13px;
            background: #f8faff;
            border: 1px solid var(--border);
            color: var(--muted);
        }
        .status.ok { border-color: #b9ecd9; background: #f2fcf8; color: var(--ok); }
        .status.err { border-color: #f1c0ce; background: #fff6f8; color: var(--danger); }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
            margin-top: 8px;
        }
        th, td {
            border-bottom: 1px solid #ecf0ff;
            padding: 9px 8px;
            text-align: left;
            vertical-align: top;
        }
        th { color: var(--muted); font-weight: 600; }
        .pill {
            display: inline-block;
            border: 1px solid var(--border);
            border-radius: 999px;
            padding: 4px 9px;
            font-size: 12px;
            color: var(--muted);
        }
        .hidden { display: none; }
        a { color: #2e56ff; text-decoration: none; }
    </style>
</head>
<body>
<main class="wrap">
    <section class="panel">
        <h1>Admin Portal</h1>
        <p>Sign in and manage employees + attendance from one place.</p>
        <div class="row" style="margin-top:10px;">
            <a href="/">Back Home</a>
            <a href="/user">Open User Portal</a>
            <a href="/health" target="_blank" rel="noreferrer">Health Check</a>
        </div>
    </section>

    <section class="panel" id="loginPanel">
        <h3>Admin Login</h3>
        <div class="grid" style="margin-top:10px;">
            <input id="username" placeholder="Username" value="{{ admin_username }}" autocomplete="username" />
            <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
        </div>
        {% if show_dev_password_hint and admin_password_hint %}
        <p style="margin-top:8px;">Dev hint: password is <span class="pill">{{ admin_password_hint }}</span></p>
        {% endif %}
        <div class="row" style="margin-top:10px;">
            <button id="loginBtn">Login</button>
            <button id="clearTokenBtn" class="secondary" type="button">Clear Session</button>
        </div>
        <div id="status" class="status">Ready</div>
    </section>

    <section class="panel hidden" id="dashboardPanel">
        <div class="row" style="justify-content:space-between; align-items:center;">
            <h3>Dashboard</h3>
            <span id="authBadge" class="pill">Not authenticated</span>
        </div>

        <article class="panel" style="margin:12px 0 0 0;">
            <h3>Quick Create Employee</h3>
            <p>Create login-ready users quickly. (Face images can be added later.)</p>
            <div class="grid" style="margin-top:10px;">
                <input id="newName" placeholder="Name (example: Sumit Thakur)" />
                <input id="newLoginId" placeholder="Login ID (example: sumit)" />
                <input id="newDepartment" placeholder="Department (default: General)" />
                <input id="newPassword" placeholder="Password (letters + numbers)" type="text" />
            </div>
            <div class="row" style="margin-top:10px;">
                <button id="createEmployeeBtn" type="button">Create Employee</button>
            </div>
        </article>

        <div class="row" style="margin-top:10px;">
            <button id="refreshBtn" class="secondary" type="button">Refresh Data</button>
            <button id="trainBtn" type="button">Train Model</button>
            <button id="logoutBtn" class="ghost" type="button">Logout</button>
        </div>

        <div class="grid" style="margin-top:12px;">
            <article class="panel" style="margin:0;">
                <h3>Employees</h3>
                <div id="employeesCount" class="pill">0 records</div>
                <table>
                    <thead><tr><th>Name</th><th>Login ID</th><th>Dept</th><th>Password Status</th></tr></thead>
                    <tbody id="employeesBody"></tbody>
                </table>
            </article>

            <article class="panel" style="margin:0;">
                <h3>Attendance (Today)</h3>
                <div id="attendanceCount" class="pill">0 records</div>
                <table>
                    <thead><tr><th>Name</th><th>In</th><th>Out</th><th>Status</th></tr></thead>
                    <tbody id="attendanceBody"></tbody>
                </table>
            </article>
        </div>

        <article class="panel" style="margin:12px 0 0 0;">
            <h3>Training Status</h3>
            <div id="trainStatus" class="status">Not checked</div>
        </article>
    </section>
</main>

<script>
    const statusBox = document.getElementById('status');
    const loginPanel = document.getElementById('loginPanel');
    const dashboardPanel = document.getElementById('dashboardPanel');
    const authBadge = document.getElementById('authBadge');

    const tokenKey = 'faceAttendanceAdminToken';

    function setStatus(message, kind) {
        statusBox.textContent = message;
        statusBox.className = 'status';
        if (kind === 'ok') statusBox.classList.add('ok');
        if (kind === 'err') statusBox.classList.add('err');
    }

    function getToken() {
        return localStorage.getItem(tokenKey) || '';
    }

    function setAuthUI(authenticated) {
        if (authenticated) {
            dashboardPanel.classList.remove('hidden');
            authBadge.textContent = 'Authenticated';
        } else {
            dashboardPanel.classList.add('hidden');
            authBadge.textContent = 'Not authenticated';
        }
    }

    async function apiGet(url) {
        const token = getToken();
        const res = await fetch(url, {
            headers: token ? { Authorization: 'Bearer ' + token } : {}
        });
        let data = {};
        try { data = await res.json(); } catch (e) { data = { message: 'Invalid JSON response' }; }
        if (!res.ok) throw new Error(data.message || ('Request failed: ' + res.status));
        return data;
    }

    function rowHtml(cells) {
        return '<tr>' + cells.map((v) => '<td>' + (v ?? '') + '</td>').join('') + '</tr>';
    }

    async function loadDashboard() {
        try {
            const today = new Date().toISOString().slice(0, 10);
            const [employees, attendance, train] = await Promise.all([
                apiGet('/employees'),
                apiGet('/attendance?date=' + encodeURIComponent(today)),
                apiGet('/train_model/status')
            ]);

            const employeesBody = document.getElementById('employeesBody');
            const attendanceBody = document.getElementById('attendanceBody');
            employeesBody.innerHTML = '';
            attendanceBody.innerHTML = '';

            document.getElementById('employeesCount').textContent = employees.length + ' records';
            document.getElementById('attendanceCount').textContent = attendance.length + ' records';

            for (const e of employees.slice(0, 40)) {
                employeesBody.insertAdjacentHTML('beforeend', rowHtml([
                    e.name,
                    e.login_id,
                    e.department || 'General',
                    e.must_change_password ? 'Reset required' : 'Protected'
                ]));
            }
            if (!employees.length) {
                employeesBody.insertAdjacentHTML('beforeend', rowHtml(['No employees found', '', '', '']));
            }

            for (const a of attendance.slice(0, 40)) {
                attendanceBody.insertAdjacentHTML('beforeend', rowHtml([
                    a.employee_name,
                    a.check_in || '-',
                    a.check_out || '-',
                    a.status || '-'
                ]));
            }
            if (!attendance.length) {
                attendanceBody.insertAdjacentHTML('beforeend', rowHtml(['No records today', '', '', '']));
            }

            document.getElementById('trainStatus').textContent = JSON.stringify(train, null, 2);
            setStatus('Login successful. Dashboard ready.', 'ok');
        } catch (err) {
            setStatus(String(err.message || err), 'err');
        }
    }

    async function login() {
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        if (!username || !password) {
            setStatus('Username and password are required.', 'err');
            return;
        }

        setStatus('Signing in...');
        try {
            const res = await fetch('/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok || !data.token) {
                throw new Error(data.message || 'Invalid credentials');
            }
            localStorage.setItem(tokenKey, data.token);
            setAuthUI(true);
            await loadDashboard();
        } catch (err) {
            setAuthUI(false);
            setStatus(String(err.message || err), 'err');
        }
    }

    async function startTraining() {
        try {
            const token = getToken();
            const res = await fetch('/train_model', {
                method: 'POST',
                headers: token ? { Authorization: 'Bearer ' + token } : {}
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Could not start training');
            setStatus(data.message || 'Training started', 'ok');
            await loadDashboard();
        } catch (err) {
            setStatus(String(err.message || err), 'err');
        }
    }

    async function createEmployee() {
        try {
            const name = (document.getElementById('newName').value || '').trim();
            const login_id = (document.getElementById('newLoginId').value || '').trim().toLowerCase();
            const department = (document.getElementById('newDepartment').value || 'General').trim() || 'General';
            const password = document.getElementById('newPassword').value || '';
            if (!name || !login_id || !password) {
                setStatus('Name, login ID, and password are required.', 'err');
                return;
            }

            const token = getToken();
            const res = await fetch('/register_employee', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token,
                },
                body: JSON.stringify({ name, login_id, department, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Could not create employee');

            setStatus('Employee created: ' + (data.employee ? data.employee.login_id : login_id), 'ok');
            document.getElementById('newName').value = '';
            document.getElementById('newLoginId').value = '';
            document.getElementById('newDepartment').value = '';
            document.getElementById('newPassword').value = '';
            await loadDashboard();
        } catch (err) {
            setStatus(String(err.message || err), 'err');
        }
    }

    document.getElementById('loginBtn').addEventListener('click', login);
    document.getElementById('refreshBtn').addEventListener('click', loadDashboard);
    document.getElementById('trainBtn').addEventListener('click', startTraining);
    document.getElementById('createEmployeeBtn').addEventListener('click', createEmployee);
    document.getElementById('logoutBtn').addEventListener('click', () => {
        localStorage.removeItem(tokenKey);
        setAuthUI(false);
        setStatus('Logged out.', 'ok');
    });
    document.getElementById('clearTokenBtn').addEventListener('click', () => {
        localStorage.removeItem(tokenKey);
        setAuthUI(false);
        setStatus('Session cleared.', 'ok');
    });

    (async function init() {
        const token = getToken();
        if (!token) {
            setAuthUI(false);
            setStatus('Ready. Please sign in.');
            return;
        }
        setAuthUI(true);
        setStatus('Restoring previous session...');
        await loadDashboard();
    })();
</script>
</body>
</html>
        """,
        admin_username=os.getenv("ADMIN_USERNAME", "admin"),
        admin_password_hint=os.getenv("ADMIN_PASSWORD", ""),
        show_dev_password_hint=show_dev_password_hint,
    )


@app.get("/user")
def user_login_page():
    return render_template_string(
        """
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>User Portal</title>
    <style>
        :root {
            --bg: #f2f8ff;
            --card: #fff;
            --text: #132040;
            --muted: #6b7ca3;
            --border: #d9e5ff;
            --primary: #2f58ff;
            --danger: #d74f6e;
            --ok: #1f9f73;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
            background: linear-gradient(180deg, #edf4ff 0%, #f8fbff 100%);
            color: var(--text);
            min-height: 100vh;
            padding: 20px;
        }
        .wrap { max-width: 760px; margin: 0 auto; }
        .panel {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 18px;
            box-shadow: 0 14px 30px rgba(35, 62, 125, 0.08);
            margin-bottom: 14px;
        }
        h1, h2, h3 { margin: 0 0 8px 0; }
        p { margin: 0; color: var(--muted); }
        .grid { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 12px; }
        input, button {
            width: 100%;
            padding: 11px 12px;
            border: 1px solid var(--border);
            border-radius: 10px;
            font-size: 14px;
        }
        button {
            cursor: pointer;
            font-weight: 600;
            background: var(--primary);
            color: white;
            border-color: var(--primary);
        }
        button.secondary { background: white; color: var(--text); }
        .row { display: flex; flex-wrap: wrap; gap: 8px; }
        .status {
            margin-top: 10px;
            border: 1px solid var(--border);
            border-radius: 10px;
            background: #f8faff;
            color: var(--muted);
            padding: 10px;
            font-size: 13px;
            white-space: pre-wrap;
        }
        .status.ok { color: var(--ok); border-color: #b9ecd9; background: #f2fcf8; }
        .status.err { color: var(--danger); border-color: #f2becd; background: #fff6f8; }
        .hidden { display: none; }
        .pill {
            display: inline-block;
            font-size: 12px;
            color: var(--muted);
            border: 1px solid var(--border);
            border-radius: 999px;
            padding: 4px 9px;
        }
        a { color: #2f58ff; text-decoration: none; }
    </style>
</head>
<body>
<main class="wrap">
    <section class="panel">
        <h1>User Portal</h1>
        <p>Login securely and continue attendance flow without API confusion.</p>
        <div class="row" style="margin-top:10px;">
            <a href="/">Back Home</a>
            <a href="/admin">Admin Portal</a>
        </div>
    </section>

    <section class="panel" id="loginPanel">
        <h3>Login</h3>
        <div class="grid">
            <input id="login_id" placeholder="Login ID (example: sumit)" autocomplete="username" />
            <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
            <button id="loginBtn">Login</button>
        </div>
        <div id="status" class="status">Ready. Enter your login ID and password.</div>
    </section>

    <section class="panel hidden" id="profilePanel">
        <div class="row" style="justify-content:space-between; align-items:center;">
            <h3>Session</h3>
            <span id="mustChangeBadge" class="pill"></span>
        </div>
        <div id="profileText" class="status">No user details</div>

        <div class="row" style="margin-top:10px;">
            <button id="logoutBtn" class="secondary" type="button">Logout</button>
        </div>
    </section>

    <section class="panel hidden" id="changePasswordPanel">
        <h3>Change Password</h3>
        <p>This account requires a password update before regular use.</p>
        <div class="grid">
            <input id="current_password" type="password" placeholder="Current password" />
            <input id="new_password" type="password" placeholder="New password (letters + numbers)" />
            <button id="changePasswordBtn" type="button">Update Password</button>
        </div>
    </section>
</main>

<script>
    const tokenKey = 'faceAttendanceUserToken';
    const statusBox = document.getElementById('status');
    const profilePanel = document.getElementById('profilePanel');
    const changePasswordPanel = document.getElementById('changePasswordPanel');
    const profileText = document.getElementById('profileText');
    const mustChangeBadge = document.getElementById('mustChangeBadge');

    function setStatus(message, kind) {
        statusBox.textContent = message;
        statusBox.className = 'status';
        if (kind === 'ok') statusBox.classList.add('ok');
        if (kind === 'err') statusBox.classList.add('err');
    }

    function getToken() {
        return localStorage.getItem(tokenKey) || '';
    }

    function clearSession() {
        localStorage.removeItem(tokenKey);
        profilePanel.classList.add('hidden');
        changePasswordPanel.classList.add('hidden');
    }

    function showSession(employee) {
        profilePanel.classList.remove('hidden');
        const mustChange = !!employee.must_change_password;
        mustChangeBadge.textContent = mustChange ? 'Password update required' : 'Active session';
        profileText.textContent = 'Logged in as ' + (employee.name || '-') + ' (' + (employee.login_id || '-') + ') | Department: ' + (employee.department || 'General');
        if (mustChange) {
            changePasswordPanel.classList.remove('hidden');
        } else {
            changePasswordPanel.classList.add('hidden');
        }
    }

    async function login() {
        const login_id = (document.getElementById('login_id').value || '').trim().toLowerCase();
        const password = document.getElementById('password').value;

        if (!login_id || !password) {
            setStatus('Login ID and password are required.', 'err');
            return;
        }

        setStatus('Signing in...');
        try {
            const res = await fetch('/user/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ login_id, password })
            });
            const data = await res.json();
            if (!res.ok || !data.success || !data.token) {
                throw new Error(data.message || 'Login failed');
            }
            localStorage.setItem(tokenKey, data.token);
            showSession(data.employee || {});
            setStatus('Login successful.', 'ok');
        } catch (err) {
            clearSession();
            setStatus(String(err.message || err), 'err');
        }
    }

    async function changePassword() {
        const current_password = document.getElementById('current_password').value;
        const new_password = document.getElementById('new_password').value;
        const token = getToken();

        if (!token) {
            setStatus('Session expired. Please login again.', 'err');
            return;
        }

        if (!current_password || !new_password) {
            setStatus('Current password and new password are required.', 'err');
            return;
        }

        setStatus('Updating password...');
        try {
            const res = await fetch('/user/change_password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token,
                },
                body: JSON.stringify({ current_password, new_password })
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.message || 'Password update failed');
            }
            if (data.token) {
                localStorage.setItem(tokenKey, data.token);
            }
            showSession(data.employee || {});
            document.getElementById('current_password').value = '';
            document.getElementById('new_password').value = '';
            setStatus(data.message || 'Password updated successfully', 'ok');
        } catch (err) {
            setStatus(String(err.message || err), 'err');
        }
    }

    document.getElementById('loginBtn').addEventListener('click', login);
    document.getElementById('changePasswordBtn').addEventListener('click', changePassword);
    document.getElementById('logoutBtn').addEventListener('click', () => {
        clearSession();
        setStatus('Logged out.', 'ok');
    });
</script>
</body>
</html>
        """
    )


@app.post("/admin/login")
@limiter.limit("10 per minute")
def admin_login():
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username", "") or "").strip()
    password = payload.get("password", "") or ""

    if verify_admin_credentials(username, password):
        token = issue_admin_token(username)
        log_audit("admin_login", details={"username": username})
        return jsonify({"success": True, "token": token})

    log_audit("admin_login", status="failed", details={"username": username})
    return jsonify({"success": False, "message": "Invalid credentials"}), 401


@app.post("/user/login")
@limiter.limit("20 per minute")
def user_login():
    payload = request.get_json(silent=True) or {}
    login_id = (payload.get("login_id", "") or "").strip().lower()
    password = payload.get("password", "") or ""

    if not login_id or not password:
        return jsonify({"success": False, "message": "Login ID and password are required"}), 400

    employee = db.employees.find_one({"login_id": login_id})
    if not employee:
        log_audit("user_login", status="failed", details={"login_id": login_id, "reason": "not_found"})
        return jsonify({"success": False, "message": "Invalid credentials"}), 401

    password_hash = (employee.get("password_hash") or "").strip()
    if not password_hash or not check_password_hash(password_hash, password):
        log_audit("user_login", status="failed", details={"login_id": login_id, "reason": "bad_password"})
        return jsonify({"success": False, "message": "Invalid credentials"}), 401

    must_change_password = bool(employee.get("must_change_password"))
    log_audit(
        "user_login",
        target={"employee_id": str(employee.get("_id")), "login_id": login_id},
        details={"must_change_password": must_change_password},
    )
    token = issue_user_token(
        str(employee.get("_id")),
        employee.get("name", ""),
        login_id,
        must_change_password=must_change_password,
    )
    return jsonify(
        {
            "success": True,
            "token": token,
            "employee": {
                "name": employee.get("name"),
                "login_id": employee.get("login_id"),
                "department": employee.get("department", "General"),
                "must_change_password": must_change_password,
            },
        }
    )


@app.post("/auth/refresh_user")
@user_auth_required
@limiter.limit("120 per hour")
def refresh_user_session():
    claims = getattr(g, "user_claims", {}) or {}
    token = refresh_user_token(claims)
    return jsonify({"success": True, "token": token})


@app.post("/auth/refresh_admin")
@admin_auth_required
@limiter.limit("120 per hour")
def refresh_admin_session():
    claims = getattr(g, "admin_claims", {}) or {}
    token = refresh_admin_token(claims)
    return jsonify({"success": True, "token": token})


@app.post("/user/change_password")
@user_auth_required
@limiter.limit("20 per minute")
def user_change_password():
    payload = request.get_json(silent=True) or {}
    current_password = payload.get("current_password") or ""
    new_password = payload.get("new_password") or ""

    if not current_password or not new_password:
        return jsonify({"message": "Current password and new password are required"}), 400

    password_issue = _validate_password_policy(new_password, label="New password")
    if password_issue:
        return jsonify({"message": password_issue}), 400

    claims = getattr(g, "user_claims", {}) or {}
    employee_id = claims.get("employee_id")
    if not employee_id:
        return jsonify({"message": "Invalid user token"}), 401

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"_id": oid})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    existing_hash = (employee.get("password_hash") or "").strip()
    if not existing_hash or not check_password_hash(existing_hash, current_password):
        log_audit("user_change_password", status="failed", details={"reason": "incorrect_current_password"})
        return jsonify({"message": "Current password is incorrect"}), 401

    db.employees.update_one(
        {"_id": oid},
        {
            "$set": {
                "password_hash": build_password_hash(new_password),
                "must_change_password": False,
                "password_updated_by": "user",
                "password_updated_at": datetime.now(),
                "updated_at": datetime.now(),
            }
        },
    )
    persist_mock_db_now()
    login_id = employee.get("login_id", "")
    employee_name = employee.get("name", "")
    log_audit("user_change_password", target={"employee_id": str(employee.get("_id")), "login_id": login_id})
    token = issue_user_token(str(employee.get("_id")), employee_name, login_id, must_change_password=False)
    return jsonify({
        "message": "Password updated successfully",
        "token": token,
        "employee": {
            "name": employee_name,
            "login_id": login_id,
            "department": employee.get("department", "General"),
            "must_change_password": False,
        }
    })


@app.get("/user/attendance_today")
@user_auth_required
def user_attendance_today():
    claims = getattr(g, "user_claims", {}) or {}
    employee_id = claims.get("employee_id")
    if not employee_id:
        return jsonify({"message": "Invalid user token"}), 401

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid user token"}), 401

    date_str = datetime.now().strftime("%Y-%m-%d")
    row = db.attendance.find_one({"employee_id": oid, "date": date_str})

    if not row:
        return jsonify({
            "status": "not_checked_in",
            "date": date_str,
            "checked_in": False,
            "check_in": None,
            "check_out": None,
        })

    status = "checked_out" if row.get("check_out") else "checked_in"
    return jsonify({
        "status": status,
        "date": row.get("date") or date_str,
        "checked_in": True,
        "check_in": row.get("check_in"),
        "check_out": row.get("check_out"),
    })


@app.post("/register_employee")
@admin_auth_required
@limiter.limit("30 per minute")
def register_employee():
    """
    Supports:
    1) multipart/form-data with fields: name, department, files[]
    2) JSON body with fields: name, department
    """
    name = ""
    department = "General"
    login_id = ""
    password = ""
    require_face_images = False
    required_images_count = 0

    if request.content_type and "multipart/form-data" in request.content_type:
        name = (request.form.get("name") or "").strip()
        department = (request.form.get("department") or "General").strip()
        login_id = (request.form.get("login_id") or "").strip().lower()
        password = request.form.get("password") or ""
        require_face_images = str(request.form.get("require_face_images", "false")).lower() in {"1", "true", "yes", "on"}
        try:
            required_images_count = max(0, int(request.form.get("required_images_count") or 0))
        except (TypeError, ValueError):
            required_images_count = 0
        files = request.files.getlist("files")
    else:
        payload = request.get_json(silent=True) or {}
        name = (payload.get("name") or "").strip()
        department = (payload.get("department") or "General").strip()
        login_id = (payload.get("login_id") or "").strip().lower()
        password = payload.get("password") or ""
        require_face_images = bool(payload.get("require_face_images", False))
        try:
            required_images_count = max(0, int(payload.get("required_images_count") or 0))
        except (TypeError, ValueError):
            required_images_count = 0
        files = []

    min_required_images = required_images_count if required_images_count > 0 else min_enrollment_images

    if not name:
        return jsonify({"message": "Employee name is required"}), 400

    if not login_id:
        return jsonify({"message": "Login ID is required"}), 400

    login_issue = _validate_login_id(login_id)
    if login_issue:
        return jsonify({"message": login_issue}), 400

    dept_issue = _validate_department(department)
    if dept_issue:
        return jsonify({"message": dept_issue}), 400

    password_issue = _validate_password_policy(password)
    if password_issue:
        return jsonify({"message": password_issue}), 400

    folder_name = slugify_name(name)
    employee_folder = ensure_dir(DATASET_PATH / folder_name)

    saved_files = []
    skipped_files = []
    for file in files:
        if not file or not file.filename:
            continue
        if not is_image_file(file.filename):
            continue

        filename = Path(file.filename).name
        target = employee_folder / filename
        file.save(target)

        if validate_enrollment_faces:
            try:
                img = face_recognition.load_image_file(str(target))
                face_locations = face_recognition.face_locations(img, model="hog", number_of_times_to_upsample=1)
                if len(face_locations) != 1:
                    target.unlink(missing_ok=True)
                    skipped_files.append(
                        {
                            "file": filename,
                            "reason": "Image must contain exactly one face"
                        }
                    )
                    continue
            except Exception:
                target.unlink(missing_ok=True)
                skipped_files.append(
                    {
                        "file": filename,
                        "reason": "Invalid image or face not detectable"
                    }
                )
                continue

        saved_files.append(str(target))

    existing = db.employees.find_one({"name": folder_name})
    credentials_only_enrollment = len(saved_files) == 0 and allow_credentials_only_enrollment and not require_face_images

    if len(saved_files) == 0 and not credentials_only_enrollment:
        return (
            jsonify(
                {
                    "message": "No valid face image found. Capture again with clear single face.",
                    "skipped": skipped_files,
                }
            ),
            400,
        )

    if require_face_images and len(saved_files) < min_required_images:
        return (
            jsonify(
                {
                    "message": f"Auto-scan saved {len(saved_files)} valid images. Need at least {min_required_images}. Please scan again.",
                    "saved_images": len(saved_files),
                    "skipped": skipped_files,
                }
            ),
            400,
        )

    if existing:
        conflict = db.employees.find_one({"login_id": login_id, "_id": {"$ne": existing["_id"]}})
        if conflict:
            return jsonify({"message": "Login ID already exists"}), 409

        db.employees.update_one(
            {"_id": existing["_id"]},
            {
                "$set": {
                    "department": department,
                    "login_id": login_id,
                    "password_hash": build_password_hash(password),
                    "must_change_password": True,
                    "password_updated_by": "admin",
                    "password_updated_at": datetime.now(),
                    "updated_at": datetime.now(),
                }
            },
        )
        if len(saved_files) > 0:
            db.employees.update_one(
                {"_id": existing["_id"]},
                {"$set": {"image_folder": str(employee_folder)}},
            )
    else:
        if len(saved_files) < min_required_images and not credentials_only_enrollment:
            return (
                jsonify(
                    {
                        "message": f"Capture at least {min_required_images} valid face images for new employee.",
                        "saved_images": len(saved_files),
                        "skipped": skipped_files,
                    }
                ),
                400,
            )
        db.employees.insert_one(
            {
                "name": folder_name,
                "department": department,
                "login_id": login_id,
                "password_hash": build_password_hash(password),
                "must_change_password": True,
                "password_updated_by": "admin",
                "password_updated_at": datetime.now(),
                "image_folder": str(employee_folder) if len(saved_files) > 0 else "",
                "created_at": datetime.now(),
                "updated_at": datetime.now(),
            }
        )

    persist_mock_db_now()
    log_audit(
        "register_employee",
        target={"employee_name": folder_name, "login_id": login_id},
        details={
            "saved_images": len(saved_files),
            "skipped_images": len(skipped_files),
            "credentials_only_enrollment": bool(credentials_only_enrollment),
        },
    )

    auto_train_job_id = _start_training_if_idle() if len(saved_files) > 0 else None

    return jsonify(
        {
            "message": "Employee registered successfully" if len(saved_files) > 0 else "Employee created (credentials only)",
            "employee": {
                "name": folder_name,
                "department": department,
                "login_id": login_id,
                "image_folder": str(employee_folder) if len(saved_files) > 0 else "",
            },
            "saved_images": len(saved_files),
            "credentials_only_enrollment": bool(credentials_only_enrollment),
            "skipped_images": skipped_files,
            "model_training": {
                "started": bool(auto_train_job_id),
                "job_id": auto_train_job_id,
                "message": (
                    "Training started in background"
                    if auto_train_job_id
                    else ("No training needed for credentials-only enrollment" if len(saved_files) == 0 else "Training already running")
                ),
            },
        }
    )


@app.post("/train_model")
@admin_auth_required
@limiter.limit("10 per hour")
def train_model():
    with train_lock:
        if train_state["running"]:
            return (
                jsonify(
                    {
                        "message": "Training already in progress",
                        "job_id": train_state["job_id"],
                    }
                ),
                409,
            )

    job_id = str(uuid.uuid4())
    worker = threading.Thread(target=_run_training_job, args=(job_id,), daemon=True)
    worker.start()
    return jsonify({"message": "Training started", "job_id": job_id}), 202


@app.get("/train_model/status")
@admin_auth_required
def train_model_status():
    with train_lock:
        return jsonify(dict(train_state))


@app.post("/start_camera")
@admin_auth_required
@limiter.limit("20 per hour")
def start_camera():
    try:
        result = face_recognizer.start()
        return jsonify(result)
    except Exception as e:
        return jsonify({"message": str(e)}), 400


@app.post("/scan_attendance")
@user_auth_required
@limiter.limit("180 per minute")
def scan_attendance():
    claims = getattr(g, "user_claims", {}) or {}
    if claims.get("must_change_password"):
        return jsonify({"status": "password_change_required", "message": "Please change password before attendance scan"}), 403

    if not bool(enable_office_geofence) and not bool(force_office_geofence):
        return jsonify({
            "status": "geofence_disabled",
            "message": "Location verification is disabled by admin. Enable geofence in admin settings to mark attendance.",
        }), 403

    location_check = _validate_scan_location()
    if not location_check.get("ok", False):
        code = int(location_check.get("code") or 400)
        payload = {
            "status": location_check.get("status") or "location_error",
            "message": location_check.get("message") or "Location validation failed",
        }
        for key in ("distance_m", "allowed_radius_m", "effective_radius_m", "accuracy_m"):
            if key in location_check:
                payload[key] = location_check[key]
        return jsonify(payload), code

    challenge_id = (request.form.get("challenge_id") or "").strip()
    challenge_action = None
    challenge_instruction = None
    if challenge_id:
        challenge_check = _consume_scan_challenge(challenge_id, claims)
        if challenge_check.get("ok"):
            challenge_action = challenge_check.get("action")
            challenge_instruction = challenge_check.get("instruction")

    image_file = request.files.get("image")
    if not image_file:
        return jsonify({"status": "wrong_data", "message": "Image file is required"}), 400

    raw = image_file.read()
    if not raw:
        return jsonify({"status": "wrong_data", "message": "Empty image"}), 400

    arr = np.frombuffer(raw, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return jsonify({"status": "wrong_data", "message": "Invalid image format"}), 400

    try:
        expected_name = claims.get("employee_name")
        employee_id = claims.get("employee_id")
        if employee_id:
            try:
                from bson import ObjectId
                row = db.employees.find_one({"_id": ObjectId(employee_id)})
                if not row or not row.get("name"):
                    return jsonify({"status": "wrong_data", "message": "Invalid user session"}), 401
                expected_name = row.get("name")
            except Exception:
                return jsonify({"status": "wrong_data", "message": "Invalid user session"}), 401

        if not str(expected_name or "").strip():
            return jsonify({"status": "wrong_data", "message": "Invalid user session"}), 401

        result = face_recognizer.scan_frame(
            frame,
            expected_name=expected_name,
            challenge_action=challenge_action,
        )

        normalized_expected = str(expected_name or "").strip().lower()
        normalized_detected = str(result.get("employee_name") or "").strip().lower()
        if (
            normalized_expected
            and normalized_detected
            and normalized_expected != normalized_detected
            and result.get("status") in {"checked_in", "checked_out", "already_recorded"}
        ):
            return jsonify({"status": "wrong_data", "message": "User face is not matching"}), 422

        if (
            result.get("status") == "wrong_data"
            and (
                "model not trained" in str(result.get("message", "")).lower()
                or "profile is not trained" in str(result.get("message", "")).lower()
            )
        ):
            job_id = _start_training_if_idle()
            return jsonify(
                {
                    "status": "model_not_ready",
                    "message": (
                        "Model is not trained yet. Training started in background. "
                        "Please retry in a few seconds."
                        if job_id
                        else "Model training is already running. Please retry in a few seconds."
                    ),
                    "training_started": bool(job_id),
                    "job_id": job_id,
                }
            ), 409
        if location_check.get("enabled"):
            result["location"] = {
                "verified": True,
                "distance_m": location_check.get("distance_m"),
                "allowed_radius_m": location_check.get("allowed_radius_m"),
                "effective_radius_m": location_check.get("effective_radius_m"),
                "accuracy_m": location_check.get("accuracy_m"),
            }
        else:
            result["location"] = {
                "verified": True,
                "enabled": False,
            }
        if challenge_action:
            result["challenge"] = {
                "action": challenge_action,
                "instruction": challenge_instruction,
            }
        code = 200 if result.get("status") != "wrong_data" else 422
        return jsonify(result), code
    except Exception as e:
        return jsonify({"status": "wrong_data", "message": str(e)}), 400


@app.get("/scan_challenge")
@user_auth_required
@limiter.limit("240 per minute")
def scan_challenge():
    claims = getattr(g, "user_claims", {}) or {}
    if claims.get("must_change_password"):
        return jsonify({"status": "password_change_required", "message": "Please change password before attendance scan"}), 403

    issued = _issue_scan_challenge(claims)
    return jsonify(issued)


@app.post("/manual_attendance_request")
@user_auth_required
@limiter.limit("30 per minute")
def manual_attendance_request():
    payload = request.form if request.form else (request.get_json(silent=True) or {})
    claims = getattr(g, "user_claims", {}) or {}
    if claims.get("must_change_password"):
        return jsonify({"message": "Please change password before submitting manual request"}), 403

    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    reason = (payload.get("reason") or "").strip()
    request_type = (payload.get("request_type") or "outside_office").strip().lower()
    work_mode = (payload.get("work_mode") or ("wfh" if request_type == "wfh" else "office")).strip().lower()

    if request_type not in {"outside_office", "wfh", "other"}:
        return jsonify({"message": "Invalid request type"}), 400

    if work_mode not in {"office", "wfh"}:
        return jsonify({"message": "Invalid work mode"}), 400

    if not reason:
        return jsonify({"message": "Reason is required"}), 400

    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found. Use registered employee name"}), 404

    date_str = datetime.now().strftime("%Y-%m-%d")
    existing_attendance = db.attendance.find_one({"employee_id": employee.get("_id"), "date": date_str})
    if existing_attendance:
        return jsonify({
            "status": "attendance_exists",
            "message": "Attendance already marked for today. Manual request not allowed",
            "date": date_str,
        }), 409

    pending_request = db.manual_requests.find_one(
        {
            "employee_name": employee_name,
            "date": date_str,
            "status": "pending",
        }
    )
    if pending_request:
        return jsonify({
            "status": "manual_request_pending",
            "message": "Manual request already pending for today",
            "date": date_str,
        }), 409

    location = {}
    for key in ("lat", "lng", "accuracy"):
        raw = payload.get(key)
        if raw is None or str(raw).strip() == "":
            continue
        try:
            location[key] = float(raw)
        except (TypeError, ValueError):
            return jsonify({"message": f"Invalid location field: {key}"}), 400

    image_file = request.files.get("image")
    if not image_file or not image_file.filename:
        return jsonify({"message": "Camera image is required for manual request"}), 400

    raw = image_file.read()
    if not raw:
        return jsonify({"message": "Uploaded image is empty"}), 400
    arr = np.frombuffer(raw, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return jsonify({"message": "Invalid image format"}), 400

    image_name = f"manual_{uuid.uuid4().hex}.jpg"
    target = MANUAL_REQUESTS_IMAGE_DIR / image_name
    cv2.imwrite(str(target), frame)
    image_path = str(target)

    now = datetime.now()
    doc = {
        "employee_name": employee_name,
        "date": date_str,
        "request_type": request_type,
        "work_mode": work_mode,
        "reason": reason,
        "status": "pending",
        "location": location,
        "image_path": image_path,
        "created_at": now,
        "updated_at": now,
    }

    result = db.manual_requests.insert_one(doc)
    persist_mock_db_now()
    created = db.manual_requests.find_one({"_id": result.inserted_id})
    return jsonify({"message": "Manual request submitted", "request": _serialize_manual_request(created)}), 201


@app.get("/manual_requests")
@admin_auth_required
def list_manual_requests():
    status = (request.args.get("status") or "").strip().lower()
    query = {"status": status} if status else {}
    rows = list(db.manual_requests.find(query).sort("created_at", -1))
    return jsonify([_serialize_manual_request(row) for row in rows])


@app.post("/manual_requests/<request_id>/approve")
@admin_auth_required
@limiter.limit("120 per hour")
def approve_manual_request(request_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(request_id)
    except InvalidId:
        return jsonify({"message": "Invalid request id"}), 400

    row = db.manual_requests.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Request not found"}), 404

    if row.get("status") != "pending":
        return jsonify({"message": "Only pending requests can be approved"}), 409

    attendance_result = attendance_manager.mark_attendance(row.get("employee_name", ""), source="manual")
    if attendance_result.get("status") == "error":
        return jsonify({"message": attendance_result.get("message", "Unable to mark attendance")}), 400

    if attendance_result.get("status") == "already_recorded":
        now = datetime.now()
        db.manual_requests.update_one(
            {"_id": oid},
            {
                "$set": {
                    "status": "conflict",
                    "conflict_reason": "Attendance already marked for today",
                    "conflict_at": now,
                    "updated_at": now,
                    "attendance_result": attendance_result,
                }
            },
        )
        persist_mock_db_now()
        updated = db.manual_requests.find_one({"_id": oid})
        return jsonify({
            "status": "attendance_exists",
            "message": "Attendance already marked for today. Manual request moved to conflict",
            "request": _serialize_manual_request(updated),
            "attendance": attendance_result,
        }), 409

    now = datetime.now()
    db.manual_requests.update_one(
        {"_id": oid},
        {
            "$set": {
                "status": "approved",
                "approved_at": now,
                "updated_at": now,
                "attendance_result": attendance_result,
            }
        },
    )
    persist_mock_db_now()
    updated = db.manual_requests.find_one({"_id": oid})
    return jsonify({"message": "Manual request approved", "request": _serialize_manual_request(updated), "attendance": attendance_result})


@app.post("/manual_requests/<request_id>/reject")
@admin_auth_required
@limiter.limit("120 per hour")
def reject_manual_request(request_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(request_id)
    except InvalidId:
        return jsonify({"message": "Invalid request id"}), 400

    row = db.manual_requests.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Request not found"}), 404

    if row.get("status") != "pending":
        return jsonify({"message": "Only pending requests can be rejected"}), 409

    payload = request.get_json(silent=True) or {}
    reason = (payload.get("reason") or "Rejected by admin").strip()
    now = datetime.now()
    db.manual_requests.update_one(
        {"_id": oid},
        {
            "$set": {
                "status": "rejected",
                "rejection_reason": reason,
                "rejected_at": now,
                "updated_at": now,
            }
        },
    )
    persist_mock_db_now()
    updated = db.manual_requests.find_one({"_id": oid})
    return jsonify({"message": "Manual request rejected", "request": _serialize_manual_request(updated)})


@app.post("/stop_camera")
@admin_auth_required
@limiter.limit("20 per hour")
def stop_camera():
    result = face_recognizer.stop()
    return jsonify(result)


@app.get("/camera_status")
@admin_auth_required
def camera_status():
    return jsonify({"running": face_recognizer.is_running, "last_event": face_recognizer.last_event})


@app.get("/camera_events")
@admin_auth_required
def camera_events():
    return jsonify(face_recognizer.events)


@app.get("/recognition_settings")
@admin_auth_required
def recognition_settings():
    return jsonify(face_recognizer.get_settings())


@app.put("/recognition_settings")
@admin_auth_required
@limiter.limit("60 per hour")
def update_recognition_settings():
    payload = request.get_json(silent=True) or {}
    try:
        settings = face_recognizer.apply_settings(payload)
        _persist_recognition_settings()
        return jsonify({"message": "Settings updated", "settings": settings})
    except Exception as e:
        return jsonify({"message": str(e)}), 400


@app.get("/geofence_settings")
@admin_auth_required
def geofence_settings():
    return jsonify(_current_geofence_settings())


@app.put("/geofence_settings")
@admin_auth_required
@limiter.limit("60 per hour")
def update_geofence_settings():
    global enable_office_geofence, office_lat, office_lng, office_radius_meters

    payload = request.get_json(silent=True) or {}

    try:
        next_enabled = _to_bool(payload.get("enabled"), enable_office_geofence)
        next_lat = _to_optional_float(payload.get("office_lat", office_lat))
        next_lng = _to_optional_float(payload.get("office_lng", office_lng))
        next_radius = _to_optional_float(payload.get("office_radius_meters", office_radius_meters))
    except (TypeError, ValueError):
        return jsonify({"message": "Invalid geofence payload"}), 400

    if next_radius is None or next_radius < 50 or next_radius > 1000:
        return jsonify({"message": "Office radius must be between 50 and 1000 meters"}), 400

    if next_lat is not None and (next_lat < -90 or next_lat > 90):
        return jsonify({"message": "Office latitude must be between -90 and 90"}), 400

    if next_lng is not None and (next_lng < -180 or next_lng > 180):
        return jsonify({"message": "Office longitude must be between -180 and 180"}), 400

    if next_enabled and (next_lat is None or next_lng is None):
        return jsonify({"message": "Office latitude and longitude are required when geofence is enabled"}), 400

    enable_office_geofence = next_enabled
    office_lat = next_lat
    office_lng = next_lng
    office_radius_meters = float(next_radius)
    _persist_geofence_settings()

    return jsonify({"message": "Geofence settings updated", "settings": _current_geofence_settings()})


@app.get("/attendance")
@admin_auth_required
def get_attendance():
    date = request.args.get("date")
    rows = attendance_manager.list_attendance(date=date)
    return jsonify(rows)


@app.get("/employees")
@admin_auth_required
def get_employees():
    rows = attendance_manager.list_employees()
    return jsonify(rows)


@app.get("/audit_logs")
@admin_auth_required
def get_audit_logs():
    try:
        limit = int(request.args.get("limit", "200"))
    except (TypeError, ValueError):
        limit = 200
    limit = max(1, min(limit, 500))

    rows = list(db.audit_logs.find().sort("created_at", -1).limit(limit))
    items = []
    for row in rows:
        item = dict(row)
        item["id"] = str(item.pop("_id"))
        created = item.get("created_at")
        if isinstance(created, datetime):
            item["created_at"] = created.isoformat()
        items.append(item)
    return jsonify(items)


@app.put("/employees/<employee_id>")
@admin_auth_required
@limiter.limit("60 per hour")
def update_employee(employee_id):
    payload = request.get_json(silent=True) or {}
    new_name_raw = (payload.get("name") or "").strip()
    new_department = (payload.get("department") or "General").strip()
    new_login_id = (payload.get("login_id") or "").strip().lower()
    new_password = payload.get("password") or ""

    if not new_name_raw:
        return jsonify({"message": "Employee name is required"}), 400

    if not new_login_id:
        return jsonify({"message": "Login ID is required"}), 400

    login_issue = _validate_login_id(new_login_id)
    if login_issue:
        return jsonify({"message": login_issue}), 400

    dept_issue = _validate_department(new_department)
    if dept_issue:
        return jsonify({"message": dept_issue}), 400

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    current = db.employees.find_one({"_id": oid})
    if not current:
        return jsonify({"message": "Employee not found"}), 404

    new_name = slugify_name(new_name_raw)
    conflict = db.employees.find_one({"login_id": new_login_id, "_id": {"$ne": oid}})
    if conflict:
        return jsonify({"message": "Login ID already exists"}), 409

    updates = {"name": new_name, "department": new_department, "login_id": new_login_id}
    if new_password:
        password_issue = _validate_password_policy(new_password)
        if password_issue:
            return jsonify({"message": password_issue}), 400
        updates["password_hash"] = build_password_hash(new_password)
        updates["must_change_password"] = True
        updates["password_updated_by"] = "admin"
        updates["password_updated_at"] = datetime.now()

    current_folder = Path(current.get("image_folder", "")) if current.get("image_folder") else None
    if current_folder and current_folder.exists() and current.get("name") != new_name:
        new_folder = DATASET_PATH / new_name
        if new_folder.exists() and new_folder.resolve() != current_folder.resolve():
            return jsonify({"message": "Target employee folder already exists"}), 409
        current_folder.rename(new_folder)
        updates["image_folder"] = str(new_folder)

    result = attendance_manager.update_employee(employee_id, updates)
    if result.get("status") != "ok":
        return jsonify({"message": result.get("message", "Update failed")}), 400
    log_audit("update_employee", target={"employee_id": employee_id, "name": new_name, "login_id": new_login_id})

    auto_train_job_id = _start_training_if_idle()

    return jsonify(
        {
            "message": "Employee updated",
            "employee": result["employee"],
            "model_training": {
                "started": bool(auto_train_job_id),
                "job_id": auto_train_job_id,
                "message": "Training started in background" if auto_train_job_id else "Training already running",
            },
        }
    )


@app.post("/employees/<employee_id>/reset_password")
@admin_auth_required
@limiter.limit("120 per hour")
def reset_employee_password(employee_id):
    payload = request.get_json(silent=True) or {}
    new_password = payload.get("new_password") or os.getenv("DEFAULT_EMPLOYEE_PASSWORD", "")

    password_issue = _validate_password_policy(new_password)
    if password_issue:
        return jsonify({"message": password_issue}), 400

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    current = db.employees.find_one({"_id": oid})
    if not current:
        return jsonify({"message": "Employee not found"}), 404

    db.employees.update_one(
        {"_id": oid},
        {
            "$set": {
                "password_hash": build_password_hash(new_password),
                "must_change_password": True,
                "password_updated_by": "admin",
                "password_updated_at": datetime.now(),
                "updated_at": datetime.now(),
            }
        },
    )
    persist_mock_db_now()
    log_audit("reset_employee_password", target={"employee_id": employee_id, "login_id": current.get("login_id")})

    return jsonify({
        "message": "Employee password reset",
        "employee": {
            "id": employee_id,
            "name": current.get("name"),
            "login_id": current.get("login_id"),
            "must_change_password": True,
        }
    })


@app.delete("/employees/<employee_id>")
@admin_auth_required
@limiter.limit("60 per hour")
def delete_employee(employee_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    current = db.employees.find_one({"_id": oid})
    if not current:
        return jsonify({"message": "Employee not found"}), 404

    image_folder = current.get("image_folder")
    result = attendance_manager.delete_employee(employee_id)
    if result.get("status") != "ok":
        return jsonify({"message": result.get("message", "Delete failed")}), 400

    if image_folder:
        try:
            shutil.rmtree(image_folder, ignore_errors=True)
        except Exception:
            pass

    persist_mock_db_now()
    log_audit("delete_employee", target={"employee_id": employee_id, "employee_name": result.get("employee_name")})

    auto_train_job_id = _start_training_if_idle()

    return jsonify(
        {
            "message": "Employee deleted",
            "employee_name": result.get("employee_name"),
            "model_training": {
                "started": bool(auto_train_job_id),
                "job_id": auto_train_job_id,
                "message": "Training started in background" if auto_train_job_id else "Training already running",
            },
        }
    )


@app.errorhandler(RequestEntityTooLarge)
def handle_large_upload(_error):
    return jsonify({"message": "Upload too large"}), 413


@app.errorhandler(Exception)
def handle_unhandled_exception(error):
    if isinstance(error, HTTPException):
        return error

    logger.exception(
        "unhandled_exception",
        extra={
            "event": "unhandled_exception",
            "request_id": getattr(g, "request_id", None),
            "method": request.method if request else None,
            "path": request.path if request else None,
            "app_env": APP_ENV,
        },
    )
    if sentry_sdk is not None and SENTRY_ENABLED:
        sentry_sdk.capture_exception(error)
    return jsonify({"message": "Internal server error"}), 500


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    app.run(host="0.0.0.0", port=port, debug=True)
