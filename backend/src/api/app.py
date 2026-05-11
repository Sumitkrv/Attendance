import os
import math
import re
import random
import shutil
import base64
import binascii
import threading
import uuid
import time
import json
import logging
import hashlib
import mimetypes
import io
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import urlopen
from bson import json_util
from bson import ObjectId

from src.utils.company_scope import (
    employee_doc_matches_company,
    employees_match_query_for_company,
    list_company_employee_object_ids,
)
from bson.binary import Binary
from typing import Optional, Tuple, List
from urllib.parse import urlparse

import cv2
import numpy as np
try:
    import face_recognition
except Exception:  # pragma: no cover - optional dependency
    face_recognition = None
from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, render_template_string, redirect, send_file
from flask.json.provider import DefaultJSONProvider
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from pymongo import MongoClient
from pymongo.errors import BulkWriteError, PyMongoError, ServerSelectionTimeoutError, DuplicateKeyError
from werkzeug.exceptions import HTTPException
from werkzeug.exceptions import RequestEntityTooLarge

if __package__ is None or __package__ == "":
    import sys

    _backend_root = Path(__file__).resolve().parents[2]
    if str(_backend_root) not in sys.path:
        sys.path.insert(0, str(_backend_root))

from src.attendance.attendance_manager import AttendanceManager, ist_now, normalize_attendance_row_times
try:
    from src.recognize_faces import FaceRecognizer
except Exception:  # pragma: no cover - optional dependency
    FaceRecognizer = None
from src.security import (
    admin_auth_required,
    build_password_hash,
    decode_admin_token,
    decode_user_token,
    get_token_policy,
    issue_admin_token,
    issue_user_token,
    refresh_admin_token,
    refresh_user_token,
    user_auth_required,
    verify_admin_credentials,
    _is_production_env,
)
from werkzeug.security import check_password_hash
try:
    from src.train_model import ModelTrainer
except Exception:  # pragma: no cover - optional dependency
    ModelTrainer = None
from src.utils.helpers import ensure_dir, is_image_file, slugify_name
from src.policy_engine import init_policy_db, policy_blueprint
from src.policy_engine.database import get_session as get_policy_session
from src.policy_engine.service import calculate_attendance, resolve_policy_for_employee
from src.routes.warning import create_warning_blueprint, start_warning_scheduler
from src.routes.api_docs import api_docs_bp
from src.routes.leave_management import leave_mgmt_bp
from src.routes.multi_geofence import multi_geofence_bp
from src.routes.shift_scheduling import shift_bp
from src.routes.bulk_import import bulk_import_bp
from src.routes.payroll import payroll_bp
from src.routes.reports import reports_bp
from src.routes.realtime import realtime_bp
from src.routes.whitelabel import whitelabel_bp
from src.middleware.rbac import require_permission, require_role, ROLES, PERMISSIONS
from src.middleware.multi_tenant import multi_tenant_bp, resolve_tenant

try:
    import mongomock
except Exception:
    mongomock = None

try:
    import redis
except Exception:
    redis = None

try:
    import cloudinary
    import cloudinary.uploader
except Exception:
    cloudinary = None

try:
    import sentry_sdk
    from sentry_sdk.integrations.flask import FlaskIntegration
except Exception:
    sentry_sdk = None
    FlaskIntegration = None

try:
    import orjson
except Exception:
    orjson = None

try:
    from flask_compress import Compress
except Exception:
    Compress = None

BASE_DIR = Path(__file__).resolve().parents[2]
APP_TIMEZONE = os.getenv("APP_TIMEZONE", "Asia/Kolkata").strip() or "Asia/Kolkata"
os.environ["TZ"] = APP_TIMEZONE
if hasattr(time, "tzset"):
    time.tzset()


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
            "content_type",
            "content_length",
            "form_keys",
            "file_keys",
            "validation_error",
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


def _log_missing_env_warnings():
    required_common = ["SECRET_KEY", "MONGODB_URI", "MONGODB_DB", "ALLOWED_ORIGINS"]
    required_prod_only = [
        "ADMIN_USERNAME",
        "ADMIN_PASSWORD_HASH",
        "OFFICE_LAT",
        "OFFICE_LNG",
        "OFFICE_RADIUS_METERS",
    ]

    required = list(required_common)
    if APP_ENV in {"prod", "production"}:
        required.extend(required_prod_only)

    missing = [key for key in required if not str(os.getenv(key, "")).strip()]
    if missing:
        logger.warning(
            "missing_env_vars: %s",
            ", ".join(missing),
            extra={"event": "missing_env_vars", "app_env": APP_ENV},
        )


def _required_env_keys_for_current_env() -> list:
    required_common = ["SECRET_KEY", "MONGODB_URI", "MONGODB_DB", "ALLOWED_ORIGINS"]
    required_prod_only = [
        "ADMIN_USERNAME",
        "ADMIN_PASSWORD_HASH",
        "OFFICE_LAT",
        "OFFICE_LNG",
        "OFFICE_RADIUS_METERS",
    ]

    keys = list(required_common)
    if APP_ENV in {"prod", "production"}:
        keys.extend(required_prod_only)
    return keys


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
_log_missing_env_warnings()


class _OrjsonProvider(DefaultJSONProvider):
    def dumps(self, obj, **kwargs):
        if orjson is None:
            return super().dumps(obj, **kwargs)
        return orjson.dumps(obj).decode("utf-8")

    def loads(self, s, **kwargs):
        if orjson is None:
            return super().loads(s, **kwargs)
        if isinstance(s, str):
            s = s.encode("utf-8")
        return orjson.loads(s)


app = Flask(__name__)

DEFAULT_CORS_ORIGINS = [
    "https://attendance-frontend-virid-one.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
]

allowed_origins_env = str(os.getenv("ALLOWED_ORIGINS", "")).strip()
cors_allow_all = str(os.getenv("CORS_ALLOW_ALL", "false")).strip().lower() in {"1", "true", "yes", "on"}
cors_allowed_origin_regex_env = str(
    os.getenv("CORS_ALLOWED_ORIGIN_REGEX", r"^https://attendance-frontend(?:-[a-z0-9-]+)?\.vercel\.app$")
).strip()

if allowed_origins_env:
    env_origins = [origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()]
else:
    env_origins = []

cors_origins = list(dict.fromkeys(DEFAULT_CORS_ORIGINS + env_origins))

try:
    cors_allowed_origin_regex = re.compile(cors_allowed_origin_regex_env, flags=re.IGNORECASE)
except re.error:
    cors_allowed_origin_regex = None


def _is_origin_allowed(origin: str) -> bool:
    value = str(origin or "").strip()
    if not value:
        return False
    if value in cors_origins:
        return True
    if cors_allowed_origin_regex is not None and cors_allowed_origin_regex.match(value):
        return True
    return False

if cors_allow_all:
    CORS(app)
else:
    CORS(
        app,
        resources={r"/*": {"origins": cors_origins + ([cors_allowed_origin_regex_env] if cors_allowed_origin_regex else [])}},
        supports_credentials=True,
        allow_headers=["Content-Type", "Authorization", "Cache-Control", "cache-control"],
        methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    )

if orjson is not None:
    app.json_provider_class = _OrjsonProvider
    app.json = app.json_provider_class(app)

if Compress is not None:
    app.config["COMPRESS_ALGORITHM"] = ["gzip"]
    app.config["COMPRESS_LEVEL"] = int(os.getenv("GZIP_LEVEL", "6"))
    app.config["COMPRESS_MIN_SIZE"] = int(os.getenv("GZIP_MIN_SIZE", "1024"))
    Compress(app)

max_upload_mb = float(os.getenv("MAX_CONTENT_LENGTH_MB", "10"))
app.config["MAX_CONTENT_LENGTH"] = int(max_upload_mb * 1024 * 1024)

rate_limit_storage_uri = str(os.getenv("RATE_LIMIT_STORAGE_URI", "memory://")).strip() or "memory://"
try:
    _rate_hour = int(os.getenv("API_RATE_LIMIT_PER_HOUR", "15000") or "15000")
except ValueError:
    _rate_hour = 15000
try:
    _rate_min = int(os.getenv("API_RATE_LIMIT_PER_MINUTE", "900") or "900")
except ValueError:
    _rate_min = 900


def _api_rate_limit_enabled() -> bool:
    """In local dev, limits are off by default (polling + HMR causes 429s). Set API_RATE_LIMIT_ENABLED=true to test."""
    raw = str(os.getenv("API_RATE_LIMIT_ENABLED", "")).strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return APP_ENV not in {"dev"}


_rate_limit_on = _api_rate_limit_enabled()
if not _rate_limit_on:
    logger.info(
        "API rate limiting is disabled (APP_ENV=dev). Set API_RATE_LIMIT_ENABLED=true to enable.",
        extra={"event": "api_rate_limiting_disabled", "app_env": APP_ENV},
    )

sync_model_artifact = str(
    os.getenv("SYNC_MODEL_ARTIFACT", "true" if APP_ENV in {"prod", "staging"} else "false")
).strip().lower() in {"1", "true", "yes", "on"}
model_artifact_max_mb = max(1.0, float(os.getenv("MODEL_ARTIFACT_MAX_MB", "14")))
MODEL_ARTIFACT_KEY = "trained_model_artifact"
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=(
        [f"{max(1000, _rate_hour)} per hour", f"{max(100, _rate_min)} per minute"]
        if _rate_limit_on
        else []
    ),
    storage_uri=rate_limit_storage_uri,
    enabled=_rate_limit_on,
)
DATASET_PATH = BASE_DIR / os.getenv("DATASET_PATH", "../persistent/dataset")
MODEL_PATH = BASE_DIR / os.getenv("MODEL_PATH", "../persistent/models/face_encodings.pkl")
MANUAL_REQUESTS_IMAGE_DIR = BASE_DIR / os.getenv("MANUAL_REQUESTS_IMAGE_DIR", "../persistent/manual_requests")
ASSETS_DIR = BASE_DIR / os.getenv("ASSETS_DIR", "../persistent/assets")
ASSETS_STORAGE = str(os.getenv("ASSETS_STORAGE", "local")).strip().lower() or "local"
CLOUDINARY_CLOUD_NAME = str(os.getenv("CLOUDINARY_CLOUD_NAME", "")).strip()
CLOUDINARY_API_KEY = str(os.getenv("CLOUDINARY_API_KEY", "")).strip()
CLOUDINARY_API_SECRET = str(os.getenv("CLOUDINARY_API_SECRET", "")).strip()
CLOUDINARY_ASSETS_FOLDER = str(os.getenv("CLOUDINARY_ASSETS_FOLDER", "hrms-employee-assets")).strip() or "hrms-employee-assets"
ASSET_MAX_FILE_SIZE_MB = max(1, int(float(os.getenv("ASSET_MAX_FILE_SIZE_MB", "10"))))
ASSET_MAX_FILE_SIZE_BYTES = ASSET_MAX_FILE_SIZE_MB * 1024 * 1024
ALLOWED_ASSET_EXTENSIONS = {
    ".jpg": {"type": "image", "mimes": {"image/jpeg"}},
    ".jpeg": {"type": "image", "mimes": {"image/jpeg"}},
    ".png": {"type": "image", "mimes": {"image/png"}},
    ".mp4": {"type": "video", "mimes": {"video/mp4"}},
    ".pdf": {"type": "document", "mimes": {"application/pdf"}},
    ".docx": {
        "type": "document",
        "mimes": {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/zip",
        },
    },
}
cloudinary_enabled = bool(
    ASSETS_STORAGE == "cloudinary"
    and cloudinary is not None
    and CLOUDINARY_CLOUD_NAME
    and CLOUDINARY_API_KEY
    and CLOUDINARY_API_SECRET
)

if cloudinary_enabled:
    cloudinary.config(
        cloud_name=CLOUDINARY_CLOUD_NAME,
        api_key=CLOUDINARY_API_KEY,
        api_secret=CLOUDINARY_API_SECRET,
        secure=True,
    )

ensure_dir(DATASET_PATH)
ensure_dir(MODEL_PATH.parent)
ensure_dir(MANUAL_REQUESTS_IMAGE_DIR)
ensure_dir(ASSETS_DIR)

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
app.config["MONGO_DB"] = db
db.audit_logs.create_index([("created_at", -1)])
db.tasks.create_index([("assigned_to", 1), ("status", 1), ("deadline", 1)])
db.departments.create_index("name", unique=True)
db.roles.create_index("name", unique=True)
db.manual_requests.create_index([("employee_id", 1), ("date", 1), ("status", 1)])
db.manual_requests.create_index([("employee_id", 1), ("source", 1), ("created_at", -1)])
db.leave_requests.create_index([("employee_id", 1), ("start_date", 1), ("end_date", 1), ("status", 1)])
db.attendance.create_index([("employee_id", 1), ("date", -1)])
db.attendance.create_index([("date", -1)])
db.attendance_logs.create_index([("employee_id", 1), ("date", -1)])
db.attendance_logs.create_index([("date", -1)])
db.assets.create_index([("employee_id", 1), ("created_at", -1)])
db.assets.create_index([("employee_id", 1), ("file_type", 1), ("created_at", -1)])
db.assets.create_index([("employee_id", 1), ("checksum", 1)])
db.support_tickets.create_index([("employee_id", 1), ("created_at", -1)])
db.support_tickets.create_index([("ticket_id", 1)], unique=True)
db.support_tickets.create_index([("status", 1), ("updated_at", -1)])
db.notifications.create_index([("createdAt", -1)])
db.notifications.create_index([("userId", 1), ("createdAt", -1)])
db.notifications.create_index([("isRead", 1), ("createdAt", -1)])
db.warning_logs.create_index([("employee_id", 1), ("created_at", -1)])
db.admin_accounts.create_index("username", unique=True)
db.admin_sessions.create_index([("username", 1), ("jti", 1)], unique=True)
db.admin_sessions.create_index([("username", 1), ("last_seen_at", -1)])


def _seed_catalog_defaults():
    now = datetime.now()
    for name in ("General",):
        try:
            db.departments.update_one(
                {"name": name},
                {"$setOnInsert": {"name": name, "created_at": now, "updated_at": now}},
                upsert=True,
            )
        except Exception:
            pass

    for name in ("staff", "manager", "admin"):
        try:
            db.roles.update_one(
                {"name": name},
                {"$setOnInsert": {"name": name, "created_at": now, "updated_at": now}},
                upsert=True,
            )
        except Exception:
            pass


_seed_catalog_defaults()
init_policy_db()
app.register_blueprint(policy_blueprint)
app.register_blueprint(policy_blueprint, url_prefix="/api", name="policy_engine_api")
app.register_blueprint(api_docs_bp)
app.register_blueprint(leave_mgmt_bp)
app.register_blueprint(multi_geofence_bp)
app.register_blueprint(shift_bp)
app.register_blueprint(bulk_import_bp)
app.register_blueprint(payroll_bp)
app.register_blueprint(reports_bp)
app.register_blueprint(realtime_bp)
app.register_blueprint(multi_tenant_bp)
app.register_blueprint(whitelabel_bp)
app.config["_db"] = db  # Share DB reference with blueprints


def _log_registered_routes():
    try:
        payroll_routes = []
        for rule in app.url_map.iter_rules():
            if str(rule.rule).startswith("/api/payroll/payslips"):
                methods = sorted(m for m in rule.methods if m not in {"HEAD", "OPTIONS"})
                payroll_routes.append(f"{','.join(methods)} {rule.rule}")
        if payroll_routes:
            for line in sorted(payroll_routes):
                logger.info("payroll_route_registered", extra={"event": "payroll_route_registered", "route": line})
    except Exception:
        logger.exception("route_logging_failed", extra={"event": "route_logging_failed"})


_log_registered_routes()


@app.get("/api/_debug/payroll-routes")
def debug_payroll_routes():
    routes = []
    for rule in app.url_map.iter_rules():
        if str(rule.rule).startswith("/api/payroll/payslips"):
            methods = sorted(m for m in rule.methods if m not in {"HEAD", "OPTIONS"})
            routes.append({"path": rule.rule, "methods": methods})
    return jsonify({"success": True, "routes": routes})

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
try:
    min_password_length = max(5, int(os.getenv("MIN_PASSWORD_LENGTH", "6")))
except (TypeError, ValueError):
    min_password_length = 6
require_password_mix = str(os.getenv("REQUIRE_PASSWORD_MIX", "true")).lower() in {"1", "true", "yes", "on"}
enable_debug_env_endpoint = str(
    os.getenv("ENABLE_DEBUG_ENV_ENDPOINT", "false" if APP_ENV in {"prod", "production"} else "true")
).lower() in {"1", "true", "yes", "on"}


def _validate_password_policy(password: str, label: str = "Password") -> Optional[str]:
    text = str(password or "")
    if len(text) < min_password_length:
        return f"{label} must be at least {min_password_length} characters"

    has_digit = bool(re.search(r"\d", text))
    if not has_digit:
        return f"{label} must include at least one number"

    if require_password_mix:
        has_letter = bool(re.search(r"[A-Za-z]", text))
        if not has_letter:
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


def _validate_email(email: str) -> Optional[str]:
    value = str(email or "").strip().lower()
    if not value:
        return "Email is required"
    if len(value) > 128:
        return "Email must be at most 128 characters"
    if not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", value):
        return "Invalid email format"
    return None


def _derive_login_id_from_email(email: str) -> str:
    value = str(email or "").strip().lower()
    local = value.split("@", 1)[0] if "@" in value else value
    local = re.sub(r"[^a-z0-9._-]+", "", local)
    return local[:32]


def _normalize_employee_status(status_value, fallback: str = "active") -> str:
    value = str(status_value or fallback or "active").strip().lower()
    return "inactive" if value == "inactive" else "active"


def _normalize_role_name(role_value, fallback: str = "staff") -> str:
    value = str(role_value or fallback or "staff").strip()
    return value if value else "staff"


def _compensation_block_from_employee_row(row: dict) -> dict:
    """HRMS compensation — canonical monthly gross is stored on employee as monthly_salary."""
    if not isinstance(row, dict):
        row = {}
    st = str(row.get("salary_type") or "CTC_BASED")
    if st not in ("IN_HAND", "CTC_BASED"):
        st = "CTC_BASED"
    ms = float(row.get("monthly_salary") or 0.0)
    nt = float(row.get("net_target_monthly") or 0.0)
    return {
        "monthlyGrossSalary": ms,
        "salaryType": st,
        "netTargetMonthly": nt,
        "payrollBasis": "MONTHLY_GROSS",
        "currency": "INR",
    }


def _serialize_employee_doc(doc: dict) -> dict:
    if not isinstance(doc, dict):
        return {}

    row = dict(doc)
    if "_id" in row:
        row["id"] = str(row.pop("_id"))

    row.pop("password_hash", None)
    row.pop("password_visible_for_admin", None)

    for key in ("created_at", "updated_at", "password_updated_at"):
        if isinstance(row.get(key), datetime):
            row[key] = row[key].isoformat()

    row["name"] = str(row.get("name") or "").strip()
    row["email"] = str(row.get("email") or "").strip().lower()
    row["login_id"] = str(row.get("login_id") or "").strip().lower()
    row["department"] = str(row.get("department") or "General").strip() or "General"
    row["role"] = _normalize_role_name(row.get("role"), fallback="staff")
    row["status"] = _normalize_employee_status(row.get("status"))

    if row["status"] == "active":
        row["is_active"] = True
        row["active"] = True
    else:
        row["is_active"] = False
        row["active"] = False

    row["monthly_salary"] = float(row.get("monthly_salary") or 0.0)
    if "work_policy" not in row or not isinstance(row.get("work_policy"), dict):
        row["work_policy"] = {}

    # Dual salary type fields
    row["salary_type"] = str(row.get("salary_type") or "CTC_BASED")
    if row["salary_type"] not in ("IN_HAND", "CTC_BASED"):
        row["salary_type"] = "CTC_BASED"
    row["net_target_monthly"] = float(row.get("net_target_monthly") or 0.0)

    # Compensation envelope (payroll / payslip read this; monthly_salary remains DB source)
    row["compensation"] = _compensation_block_from_employee_row(row)
    row["portal_access"] = bool(row.get("portal_access", True))
    row["send_invite_email"] = bool(row.get("send_invite_email", False))

    # ── Extended profile fields ───────────────────────────────────────────────
    str_fields = [
        "designation", "father_name", "dob", "gender", "blood_group",
        "marital_status", "mobile", "emergency_contact_name",
        "emergency_contact_phone", "permanent_address",
        "emp_id", "date_of_joining", "employment_type", "reporting_manager",
        "company_name", "aadhaar_number", "pan_number",
        "bank_account_no", "bank_ifsc", "bank_name", "photo_url",
    ]
    for f in str_fields:
        row[f] = str(row.get(f) or "")

    return row


def _catalog_collection(kind: str):
    key = str(kind or "").strip().lower()
    if key == "departments":
        return db.departments, "department"
    if key == "roles":
        return db.roles, "role"
    return None, "item"


def _serialize_catalog_doc(doc: dict) -> dict:
    if not isinstance(doc, dict):
        return {}
    row = dict(doc)
    if "_id" in row:
        row["id"] = str(row.pop("_id"))
    row["name"] = str(row.get("name") or "").strip()
    for key in ("created_at", "updated_at"):
        if isinstance(row.get(key), datetime):
            row[key] = row[key].isoformat()
    return row


@app.after_request
def _set_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(self), geolocation=(self)")
    response.headers.setdefault("Cache-Control", "no-store")

    request_origin = request.headers.get("Origin", "").strip()
    if cors_allow_all:
        response.headers["Access-Control-Allow-Origin"] = "*"
    elif _is_origin_allowed(request_origin):
        response.headers["Access-Control-Allow-Origin"] = request_origin
    else:
        response.headers["Access-Control-Allow-Origin"] = "https://attendance-frontend-virid-one.vercel.app"

    response.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization,Cache-Control,cache-control"
    response.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    if not cors_allow_all:
        response.headers["Access-Control-Allow-Credentials"] = "true"

    vary_header = response.headers.get("Vary", "")
    if "Origin" not in vary_header:
        response.headers["Vary"] = f"{vary_header}, Origin".strip(", ")

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


@app.route("/", methods=["OPTIONS"])
def _cors_options_root():
    return "", 204


@app.route("/<path:_any>", methods=["OPTIONS"])
def _cors_options_any(_any):
    return "", 204


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
location_max_age_seconds = max(5, int(os.getenv("LOCATION_MAX_AGE_SECONDS", "25")))
max_reported_accuracy_meters = max(15.0, float(os.getenv("MAX_REPORTED_GPS_ACCURACY_METERS", "300")))
scan_challenge_ttl_seconds = int(os.getenv("SCAN_CHALLENGE_TTL_SECONDS", "18"))
scan_challenge_lock = threading.Lock()
scan_challenges = {}

scan_result_cache_ttl_seconds = max(1.0, float(os.getenv("SCAN_RESULT_CACHE_TTL_SECONDS", "2.5")))
scan_result_cache = {}
scan_result_cache_lock = threading.Lock()

employee_session_cache_ttl_seconds = max(10.0, float(os.getenv("EMPLOYEE_SESSION_CACHE_TTL_SECONDS", "120")))
employee_session_cache = {}
employee_session_cache_lock = threading.Lock()

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


def _parse_location_captured_at_ms(raw_value) -> Optional[int]:
    try:
        value = int(float(raw_value))
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return value


def _get_cached_employee_name(employee_id: str) -> Optional[str]:
    if not str(employee_id or "").strip():
        return None

    now_ts = time.time()
    with employee_session_cache_lock:
        cached = employee_session_cache.get(employee_id)
        if cached and cached.get("expires_at", 0) > now_ts:
            return cached.get("name")

    try:
        from bson import ObjectId

        row = db.employees.find_one({"_id": ObjectId(employee_id)}, {"name": 1})
    except Exception:
        row = None

    name = str((row or {}).get("name") or "").strip()
    if not name:
        return None

    with employee_session_cache_lock:
        employee_session_cache[employee_id] = {
            "name": name,
            "expires_at": now_ts + employee_session_cache_ttl_seconds,
        }
    return name


def _get_scan_result_cache(cache_key: str):
    now_ts = time.time()
    with scan_result_cache_lock:
        cached = scan_result_cache.get(cache_key)
        if not cached:
            return None
        if cached.get("expires_at", 0) <= now_ts:
            scan_result_cache.pop(cache_key, None)
            return None
        return dict(cached.get("payload") or {})


def _set_scan_result_cache(cache_key: str, payload: dict):
    if not cache_key:
        return
    now_ts = time.time()
    with scan_result_cache_lock:
        scan_result_cache[cache_key] = {
            "expires_at": now_ts + scan_result_cache_ttl_seconds,
            "payload": dict(payload or {}),
        }

        if len(scan_result_cache) > 300:
            expired_keys = [k for k, v in scan_result_cache.items() if v.get("expires_at", 0) <= now_ts]
            for key in expired_keys:
                scan_result_cache.pop(key, None)


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


def _effective_geofence_for_claims(claims: Optional[dict]) -> dict:
    """Resolve office circle from employee's company attendanceSettings, else global settings."""
    claims = claims or {}
    eid = str(claims.get("employee_id") or "").strip()
    if not eid:
        return _current_geofence_settings()
    try:
        oid = ObjectId(eid)
    except Exception:
        return _current_geofence_settings()
    emp = db.employees.find_one({"_id": oid})
    if not emp:
        return _current_geofence_settings()
    return _effective_geofence_for_employee_doc(emp)


def _effective_geofence_for_employee_doc(emp: dict) -> dict:
    fallback = _current_geofence_settings()
    company_doc = None
    try:
        for c in db.companies.find({}, {"_id": 0}):
            cid = c.get("id")
            if cid and employee_doc_matches_company(db, cid, str(emp.get("company_name") or ""), str(emp.get("company_id") or "")):
                company_doc = c
                break
    except Exception:
        return fallback
    if not company_doc:
        return fallback
    att = company_doc.get("attendanceSettings") or {}
    has_company_geo = (
        "geofenceEnabled" in att
        or att.get("officeLat") not in (None, "")
        or att.get("officeLng") not in (None, "")
    )
    if not has_company_geo:
        return fallback
    enabled = bool(att.get("geofenceEnabled"))
    lat = _to_optional_float(att.get("officeLat"))
    lng = _to_optional_float(att.get("officeLng"))
    try:
        rad = float(att.get("officeRadiusMeters") or 500)
    except (TypeError, ValueError):
        rad = 500.0
    if not enabled:
        return {"enabled": False, "office_lat": lat, "office_lng": lng, "office_radius_meters": rad}
    if lat is None or lng is None:
        return {"enabled": True, "office_lat": None, "office_lng": None, "office_radius_meters": rad}
    return {"enabled": True, "office_lat": lat, "office_lng": lng, "office_radius_meters": rad}


def _validate_scan_location(
    claims: Optional[dict] = None,
    payload: Optional[dict] = None,
    use_accuracy_grace: bool = True,
):
    payload = payload or {}
    claims = claims or {}
    gf = _effective_geofence_for_claims(claims)
    geofence_active = bool(gf.get("enabled")) or bool(force_office_geofence)
    office_lat = gf.get("office_lat")
    office_lng = gf.get("office_lng")
    office_radius_meters = float(gf.get("office_radius_meters") or 500.0)

    if not geofence_active:
        return {
            "enabled": False,
            "ok": True,
            "status": "geofence_disabled",
            "message": "Location verification is disabled. Attendance allowed without location check.",
        }

    if office_lat is None or office_lng is None:
        return {
            "enabled": True,
            "ok": False,
            "code": 500,
            "status": "geofence_not_configured",
            "message": "Office location is not configured",
        }

    lat_raw = payload.get("lat")
    lng_raw = payload.get("lng")
    if lat_raw is None or lng_raw is None:
        return {
            "enabled": True,
            "ok": False,
            "code": 400,
            "status": "location_required",
            "message": "Location is required for attendance",
            "details": {
                "required_fields": ["lat", "lng"],
                "received_fields": sorted(list(payload.keys())),
            },
        }

    now_ms = int(time.time() * 1000)
    location_captured_at_ms = _parse_location_captured_at_ms(payload.get("location_captured_at_ms"))
    if location_captured_at_ms is None:
        location_captured_at_ms = now_ms

    age_ms = now_ms - location_captured_at_ms
    max_age_ms = max(int(location_max_age_seconds * 1000), 2 * 60 * 1000)
    app.logger.info("Client timestamp: %s", location_captured_at_ms)
    app.logger.info("Server time: %s", now_ms)
    if age_ms < -5000 or age_ms > max_age_ms:
        return {
            "enabled": True,
            "ok": False,
            "code": 400,
            "status": "stale_location",
            "message": f"Location is too old. Refresh location and retry within {int(max_age_ms / 1000)} seconds.",
            "location_age_ms": age_ms,
        }

    issued_at = claims.get("iat")
    if issued_at is not None:
        try:
            issued_at_ms = int(float(issued_at) * 1000)
            if location_captured_at_ms < issued_at_ms:
                return {
                    "enabled": True,
                    "ok": False,
                    "code": 403,
                    "status": "location_before_login",
                    "message": "Location must be captured after login",
                    "details": {
                        "location_captured_at_ms": location_captured_at_ms,
                        "token_iat_ms": issued_at_ms,
                    },
                }
        except (TypeError, ValueError):
            pass

    location_session_jti = (payload.get("location_session_jti") or "").strip()
    token_jti = str(claims.get("jti") or "").strip()
    if token_jti and location_session_jti and location_session_jti != token_jti:
        return {
            "enabled": True,
            "ok": False,
            "code": 403,
            "status": "location_session_mismatch",
            "message": "Location token mismatch. Please login again.",
            "details": {
                "location_session_jti": location_session_jti,
                "token_jti": token_jti,
            },
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
            "details": {
                "lat": lat_raw,
                "lng": lng_raw,
            },
        }

    if lat < -90 or lat > 90 or lng < -180 or lng > 180:
        return {
            "enabled": True,
            "ok": False,
            "code": 400,
            "status": "invalid_location",
            "message": "Invalid location range",
            "details": {
                "lat": lat,
                "lng": lng,
            },
        }

    distance_m = _haversine_meters(lat, lng, office_lat, office_lng)
    allowed_radius_m = office_radius_meters

    accuracy_raw = payload.get("accuracy")
    if accuracy_raw in {None, ""}:
        accuracy_raw = request.form.get("accuracy", "0")
    try:
        accuracy = float(accuracy_raw or 0)
    except (TypeError, ValueError):
        accuracy = 0.0

    if accuracy > max_reported_accuracy_meters:
        return {
            "enabled": True,
            "ok": False,
            "code": 403,
            "status": "low_location_accuracy",
            "message": f"Location accuracy is too low ({round(accuracy, 1)}m). Move to open sky and retry.",
            "accuracy_m": round(accuracy, 2),
        }

    # GPS can drift, especially indoors. Add optional accuracy grace window.
    # For login/session validation we keep strict radius checks.
    accuracy_grace_m = min(max(accuracy, 0.0), 200.0) if use_accuracy_grace else 0.0
    effective_radius_m = allowed_radius_m + accuracy_grace_m

    if distance_m > effective_radius_m:
        return {
            "enabled": True,
            "ok": False,
            "code": 403,
            "status": "outside_office",
            "message": (
                f"Outside office location. Distance {round(distance_m, 1)}m, "
                f"allowed {round(allowed_radius_m, 1)}m (+accuracy {round(accuracy_grace_m, 1)}m)."
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
        "location_age_ms": age_ms,
    }


def persist_mock_db_now():
    if not using_mock_db or not mock_db_persist:
        logger.debug("mock persist: skipped (using_mock_db=%s, mock_db_persist=%s)", using_mock_db, mock_db_persist)
        return

    try:
        with mock_persist_lock:
            payload = {
                "employees": list(db.employees.find()),
                "attendance": list(db.attendance.find()),
                "settings": list(db.settings.find()),
                "manual_requests": list(db.manual_requests.find()),
                "tasks": list(db.tasks.find()),
                "audit_logs": list(db.audit_logs.find().sort("created_at", -1).limit(1000)),
                "payslips": list(db.payslips.find()),
                "payroll_runs": list(db.payroll_runs.find()),
                "saved_at": datetime.now(),
            }
            dump_path = MOCK_DB_DUMP_PATH.resolve()
            ensure_dir(dump_path.parent)
            if dump_path.exists():
                try:
                    shutil.copy2(dump_path, dump_path.parent / "mock_db_dump.json.bak")
                except Exception:
                    logger.exception("mock persist: could not copy %s to .bak", dump_path)
            tmp_path = dump_path.parent / "mock_db_dump.json.tmp"
            serialized = json_util.dumps(payload)
            tmp_path.write_text(serialized, encoding="utf-8")
            tmp_path.replace(dump_path)
            logger.info(
                "mock persist: saved %d employees, %d payslips, %d payroll_runs to %s",
                len(payload["employees"]), len(payload["payslips"]), len(payload["payroll_runs"]), dump_path,
            )
    except Exception:
        logger.exception("mock persist: FAILED to write %s", MOCK_DB_DUMP_PATH)


def _snapshot_mock_user_collections() -> dict:
    return {
        "employees": list(db.employees.find({})),
        "attendance": list(db.attendance.find({})),
        "settings": list(db.settings.find({})),
        "manual_requests": list(db.manual_requests.find({})),
        "tasks": list(db.tasks.find({})),
        "audit_logs": list(db.audit_logs.find({})),
        "payslips": list(db.payslips.find({})),
        "payroll_runs": list(db.payroll_runs.find({})),
    }


def _restore_mock_user_collections(snap: dict) -> None:
    db.employees.delete_many({})
    db.attendance.delete_many({})
    db.settings.delete_many({})
    db.manual_requests.delete_many({})
    db.tasks.delete_many({})
    db.audit_logs.delete_many({})
    db.payslips.delete_many({})
    db.payroll_runs.delete_many({})
    if snap.get("employees"):
        db.employees.insert_many(snap["employees"], ordered=False)
    if snap.get("attendance"):
        db.attendance.insert_many(snap["attendance"], ordered=False)
    if snap.get("settings"):
        db.settings.insert_many(snap["settings"], ordered=False)
    if snap.get("manual_requests"):
        db.manual_requests.insert_many(snap["manual_requests"], ordered=False)
    if snap.get("tasks"):
        db.tasks.insert_many(snap["tasks"], ordered=False)
    if snap.get("audit_logs"):
        db.audit_logs.insert_many(snap["audit_logs"], ordered=False)
    if snap.get("payslips"):
        db.payslips.insert_many(snap["payslips"], ordered=False)
    if snap.get("payroll_runs"):
        db.payroll_runs.insert_many(snap["payroll_runs"], ordered=False)


def load_mock_db_dump():
    if not using_mock_db:
        return

    if mock_db_reset_on_start:
        db.employees.delete_many({})
        db.attendance.delete_many({})
        db.settings.delete_many({})
        db.manual_requests.delete_many({})
        db.tasks.delete_many({})
        db.audit_logs.delete_many({})
        db.payslips.delete_many({})
        db.payroll_runs.delete_many({})
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
    except Exception:
        logger.exception(
            "mock_db_dump: corrupt or unreadable JSON in %s — leaving current in-memory database unchanged",
            MOCK_DB_DUMP_PATH,
        )
        return

    employees_raw = payload.get("employees", []) or []
    attendance = payload.get("attendance", []) or []
    settings = payload.get("settings", []) or []
    manual_requests = payload.get("manual_requests", []) or []
    tasks = payload.get("tasks", []) or []
    audit_logs = payload.get("audit_logs", []) or []
    payslips_raw = payload.get("payslips", []) or []
    payroll_runs_raw = payload.get("payroll_runs", []) or []

    seen_emp_ids = set()
    employees = []
    for doc in employees_raw:
        if not isinstance(doc, dict):
            continue
        oid = doc.get("_id")
        if oid is not None:
            key = str(oid)
            if key in seen_emp_ids:
                continue
            seen_emp_ids.add(key)
        employees.append(doc)

    seen_slip_ids = set()
    payslips = []
    for doc in payslips_raw:
        if not isinstance(doc, dict):
            continue
        oid = doc.get("_id")
        if oid is not None:
            key = str(oid)
            if key in seen_slip_ids:
                continue
            seen_slip_ids.add(key)
        payslips.append(doc)

    seen_run_ids = set()
    payroll_runs = []
    for doc in payroll_runs_raw:
        if not isinstance(doc, dict):
            continue
        oid = doc.get("_id")
        if oid is not None:
            key = str(oid)
            if key in seen_run_ids:
                continue
            seen_run_ids.add(key)
        payroll_runs.append(doc)

    snap = _snapshot_mock_user_collections()
    try:
        db.employees.delete_many({})
        db.attendance.delete_many({})
        db.settings.delete_many({})
        db.manual_requests.delete_many({})
        db.tasks.delete_many({})
        db.audit_logs.delete_many({})
        db.payslips.delete_many({})
        db.payroll_runs.delete_many({})
        if employees:
            db.employees.insert_many(employees, ordered=False)
        if attendance:
            db.attendance.insert_many(attendance, ordered=False)
        if settings:
            db.settings.insert_many(settings, ordered=False)
        if manual_requests:
            db.manual_requests.insert_many(manual_requests, ordered=False)
        if tasks:
            db.tasks.insert_many(tasks, ordered=False)
        if audit_logs:
            db.audit_logs.insert_many(audit_logs, ordered=False)
        if payslips:
            db.payslips.insert_many(payslips, ordered=False)
        if payroll_runs:
            db.payroll_runs.insert_many(payroll_runs, ordered=False)
    except BulkWriteError:
        logger.exception(
            "mock_db_dump: bulk write failed loading %s (often duplicate employee name/login) — restoring previous state",
            MOCK_DB_DUMP_PATH,
        )
        try:
            _restore_mock_user_collections(snap)
        except Exception:
            logger.exception("mock_db_dump: rollback restore failed")
    except Exception:
        logger.exception(
            "mock_db_dump: failed applying %s — restoring previous in-memory state",
            MOCK_DB_DUMP_PATH,
        )
        try:
            _restore_mock_user_collections(snap)
        except Exception:
            logger.exception("mock_db_dump: rollback restore failed")


app.config["persist_mock_db"] = persist_mock_db_now


@app.get("/api/admin/mock-db/persist")
@app.post("/api/admin/mock-db/persist")
@admin_auth_required
def api_trigger_mock_persist():
    """Manually trigger a mock DB persist to disk."""
    if not using_mock_db:
        return jsonify({"message": "Not using mock DB", "persisted": False})
    try:
        persist_mock_db_now()
        exists = MOCK_DB_DUMP_PATH.resolve().exists()
        return jsonify({
            "message": "Persist triggered",
            "persisted": exists,
            "path": str(MOCK_DB_DUMP_PATH.resolve()),
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


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

    if item.get("employee_id") is not None:
        item["employee_id"] = str(item.get("employee_id"))

    for key in ("created_at", "updated_at", "approved_at", "rejected_at", "conflict_at"):
        value = item.get(key)
        if isinstance(value, datetime):
            item[key] = value.isoformat()

    if "created_at" in item and "requested_at" not in item:
        item["requested_at"] = item["created_at"]

    return item


def _safe_asset_filename(name: str) -> str:
    text = Path(str(name or "").strip()).name
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("._")
    if not text:
        return "file"
    return text[:140]


def _asset_type_from_file(file_name: str, mime_type: str = "") -> str:
    ext = Path(str(file_name or "")).suffix.lower()
    mime = str(mime_type or "").strip().lower()

    image_ext = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".heic"}
    video_ext = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}

    if mime.startswith("image/") or ext in image_ext:
        return "image"
    if mime.startswith("video/") or ext in video_ext:
        return "video"
    return "document"


def _validate_asset_upload(file_name: str, mime_type: str, size_bytes: int) -> Tuple[bool, str, str]:
    size = int(size_bytes or 0)
    if size <= 0:
        return False, "Uploaded file is empty", ""
    if size > ASSET_MAX_FILE_SIZE_BYTES:
        return False, "File too large", ""

    ext = Path(str(file_name or "")).suffix.lower()
    rule = ALLOWED_ASSET_EXTENSIONS.get(ext)
    if not rule:
        return False, "Unsupported file format", ""

    guessed_mime = (mimetypes.guess_type(str(file_name or ""))[0] or "").strip().lower()
    normalized_mime = str(mime_type or guessed_mime or "application/octet-stream").strip().lower()
    allowed_mimes = set(rule.get("mimes") or set())
    if normalized_mime not in allowed_mimes and normalized_mime not in {"", "application/octet-stream"}:
        return False, "Unsupported file format", ""

    return True, "", str(rule.get("type") or "document")


def _build_unique_asset_display_name(employee_oid, proposed_name: str, exclude_asset_id=None) -> str:
    from bson import ObjectId

    safe = _safe_asset_filename(proposed_name)
    base = Path(safe).stem or "file"
    ext = Path(safe).suffix.lower()
    if not ext:
        ext = ".pdf"

    query = {"employee_id": employee_oid}
    if exclude_asset_id is not None:
        oid = exclude_asset_id if isinstance(exclude_asset_id, ObjectId) else ObjectId(str(exclude_asset_id))
        query["_id"] = {"$ne": oid}

    existing_names = {
        str(row.get("file_name") or "").strip().lower()
        for row in db.assets.find(query, {"file_name": 1})
    }

    candidate = f"{base}{ext}"
    if candidate.lower() not in existing_names:
        return candidate

    index = 1
    while index <= 9999:
        candidate = f"{base}({index}){ext}"
        if candidate.lower() not in existing_names:
            return candidate
        index += 1

    return f"{base}-{uuid.uuid4().hex[:8]}{ext}"


def _cloudinary_resource_type(file_type: str) -> str:
    key = str(file_type or "").strip().lower()
    if key == "image":
        return "image"
    if key == "video":
        return "video"
    return "raw"


def _serialize_asset_doc(row: dict) -> dict:
    item = dict(row or {})
    if "_id" in item:
        item["id"] = str(item.pop("_id"))

    if item.get("employee_id") is not None:
        item["employee_id"] = str(item.get("employee_id"))

    for key in ("created_at", "updated_at"):
        value = item.get(key)
        if isinstance(value, datetime):
            item[key] = value.isoformat()

    item["file_name"] = str(item.get("file_name") or "")
    item["file_url"] = str(item.get("file_url") or "")
    item["file_type"] = str(item.get("file_type") or "document")
    item["size"] = int(item.get("size") or 0)
    item["uploaded_by"] = str(item.get("uploaded_by") or "admin")
    item["mime_type"] = str(item.get("mime_type") or "application/octet-stream")
    item["storage_provider"] = str(item.get("storage_provider") or "local")
    item["public_id"] = str(item.get("public_id") or "")
    return item


def _extract_bearer_token_from_request() -> str:
    auth_header = str(request.headers.get("Authorization", "")).strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    return ""


def _serialize_leave_request(row: dict) -> dict:
    item = dict(row or {})
    if "_id" in item:
        item["id"] = str(item.pop("_id"))

    if item.get("employee_id") is not None:
        item["employee_id"] = str(item.get("employee_id"))

    for key in ("created_at", "updated_at", "approved_at", "rejected_at"):
        value = item.get(key)
        if isinstance(value, datetime):
            item[key] = value.isoformat()

    return item


def _serialize_notification(row: dict) -> dict:
    item = dict(row or {})
    if "_id" in item:
        item["id"] = str(item.pop("_id"))

    item["message"] = str(item.get("message") or "").strip()
    item["title"] = str(item.get("title") or "Notification").strip() or "Notification"
    item["type"] = str(item.get("type") or "request").strip().lower()
    item["category"] = str(item.get("category") or item.get("type") or "general").strip().lower()
    item["priority"] = str(item.get("priority") or "medium").strip().lower()
    item["userId"] = str(item.get("userId") or "").strip()
    item["isRead"] = bool(item.get("isRead"))
    item["archived"] = bool(item.get("archived"))

    created_at = item.get("createdAt")
    if isinstance(created_at, datetime):
        item["createdAt"] = created_at.isoformat()

    return item


def _serialize_support_ticket(row: dict) -> dict:
    item = dict(row or {})
    if "_id" in item:
        item["id"] = str(item.pop("_id"))

    if item.get("employee_id") is not None:
        item["employee_id"] = str(item.get("employee_id"))

    for key in (
        "created_at",
        "updated_at",
        "resolved_at",
        "closed_at",
        "rejected_at",
    ):
        value = item.get(key)
        if isinstance(value, datetime):
            item[key] = value.isoformat()

    item["ticket_id"] = str(item.get("ticket_id") or "")
    item["category"] = str(item.get("category") or "other").strip().lower()
    item["subject"] = str(item.get("subject") or "").strip()
    item["priority"] = str(item.get("priority") or "medium").strip().lower()
    item["status"] = str(item.get("status") or "open").strip().lower()
    item["assigned_to"] = str(item.get("assigned_to") or "").strip()
    item["assigned_team"] = str(item.get("assigned_team") or "").strip()
    item["resolution_date"] = str(item.get("resolution_date") or "").strip()
    item["admin_remarks"] = str(item.get("admin_remarks") or "").strip()
    item["preferred_contact_method"] = str(item.get("preferred_contact_method") or "email").strip().lower()
    item["attachment_path"] = str(item.get("attachment_path") or "").strip()
    return item


def create_notification(
    message: str,
    ntype: str = "request",
    user_id: Optional[str] = None,
    *,
    title: str = "",
    priority: str = "medium",
    category: str = "",
    metadata: Optional[dict] = None,
):
    text = str(message or "").strip()
    if not text:
        return None

    normalized_type = str(ntype or "request").strip().lower()
    if normalized_type not in {"employee", "attendance", "leave", "request"}:
        normalized_type = "request"

    payload = {
        "title": str(title or "Notification").strip() or "Notification",
        "message": text,
        "type": normalized_type,
        "category": str(category or normalized_type or "general").strip().lower(),
        "priority": str(priority or "medium").strip().lower(),
        "userId": str(user_id or "").strip(),
        "isRead": False,
        "archived": False,
        "metadata": dict(metadata or {}),
        "createdAt": datetime.now(timezone.utc),
    }

    try:
        inserted = db.notifications.insert_one(payload)
        persist_mock_db_now()
        return str(inserted.inserted_id)
    except Exception:
        return None


TASK_STATUSES = {"not_started", "todo", "in_progress", "review", "completed", "approved", "overdue"}
TASK_PRIORITIES = {"low", "medium", "high", "urgent"}
SUPPORT_TICKET_CATEGORIES = {
    "hr_support",
    "salary_issue",
    "attendance_issue",
    "leave_issue",
    "asset_issue",
    "it_support",
    "login_problem",
    "system_error",
    "payroll_problem",
    "document_request",
}
SUPPORT_TICKET_PRIORITIES = {"low", "medium", "high"}
SUPPORT_TICKET_CONTACT_METHODS = {"email", "phone", "chat", "any"}
SUPPORT_TICKET_STATUSES = {"open", "in_progress", "resolved", "closed", "rejected"}


def _normalize_task_status(value) -> str:
    text = str(value or "").strip().lower().replace(" ", "_")
    if text == "todo":
        return "not_started"
    if text in TASK_STATUSES:
        return text
    return "not_started"


def _normalize_task_priority(value) -> str:
    text = str(value or "").strip().lower()
    if text in TASK_PRIORITIES:
        return text
    return "medium"


def _parse_task_deadline(value) -> datetime:
    text = str(value or "").strip()
    if not text:
        raise ValueError("Task deadline is required")
    try:
        date_part = datetime.strptime(text[:10], "%Y-%m-%d")
        return datetime(date_part.year, date_part.month, date_part.day, 23, 59, 59)
    except ValueError as exc:
        raise ValueError("Deadline must be in YYYY-MM-DD format") from exc


def _parse_task_start_date(value) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        date_part = datetime.strptime(text[:10], "%Y-%m-%d")
        return datetime(date_part.year, date_part.month, date_part.day, 0, 0, 0)
    except ValueError as exc:
        raise ValueError("Start date must be in YYYY-MM-DD format") from exc


def _serialize_task(row: dict) -> dict:
    item = dict(row or {})
    if "_id" in item:
        item["id"] = str(item.pop("_id"))
    for key in ("created_at", "updated_at", "completed_at", "approved_at", "deadline", "start_date"):
        value = item.get(key)
        if isinstance(value, datetime):
            item[key] = value.isoformat()
    if not isinstance(item.get("checklist_items"), list):
        item["checklist_items"] = []
    if not isinstance(item.get("tags"), list):
        item["tags"] = []
    if not isinstance(item.get("attachments"), list):
        item["attachments"] = []
    if not isinstance(item.get("comments"), list):
        item["comments"] = []
    if not isinstance(item.get("activity"), list):
        item["activity"] = []
    item["status"] = _normalize_task_status(item.get("status"))
    item["priority"] = _normalize_task_priority(item.get("priority"))
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


def _decode_any_bearer_claims() -> dict:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return {"role": "", "claims": None, "error": ("Missing bearer token", 401)}

    token = auth_header.split(" ", 1)[1].strip()
    if not token:
        return {"role": "", "claims": None, "error": ("Invalid token", 401)}

    try:
        claims = decode_admin_token(token)
        if claims.get("role") == "admin":
            return {"role": "admin", "claims": claims, "error": None}
    except Exception:
        pass

    try:
        claims = decode_user_token(token)
        if claims.get("role") == "user":
            return {"role": "user", "claims": claims, "error": None}
    except Exception:
        pass

    return {"role": "", "claims": None, "error": ("Invalid token", 401)}


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


def _seed_admin_account():
    """Seed the admin account with env credentials if no password hash is set yet.

    Runs once at startup:
    - Creates the admin document if it doesn't exist, with a hashed env password.
    - If the document exists but has no password_hash, backfills it from env.
    - If ADMIN_FORCE_RESEED=true, always overwrites the hash (dev recovery only).
    - If the admin already has a custom password_hash, leaves it untouched.
    """
    username = str(os.getenv("ADMIN_USERNAME", "admin") or "admin").strip() or "admin"
    password = str(os.getenv("ADMIN_PASSWORD", "") or "").strip()
    force_reseed = str(os.getenv("ADMIN_FORCE_RESEED", "false") or "false").strip().lower() in {"1", "true", "yes", "on"}

    if not password:
        logger.warning(
            "admin_seed_skipped",
            extra={"event": "admin_seed_skipped", "reason": "ADMIN_PASSWORD not set in env"},
        )
        return

    try:
        existing = db.admin_accounts.find_one({"username": username}) or {}
        existing_hash = str(existing.get("password_hash") or "").strip()

        if existing_hash and not force_reseed:
            return

        now_utc = datetime.now(timezone.utc)
        default_email = str(os.getenv("ADMIN_EMAIL", f"{username}@local") or f"{username}@local").strip().lower()
        default_name = str(os.getenv("ADMIN_DISPLAY_NAME", "") or "").strip() or (
            " ".join(w.capitalize() for w in username.replace(".", " ").replace("_", " ").split() if w) or "Admin"
        )

        db.admin_accounts.update_one(
            {"username": username},
            {
                "$setOnInsert": {
                    "username": username,
                    "name": default_name,
                    "email": default_email,
                    "role": "admin",
                    "created_at": now_utc,
                },
                "$set": {
                    "password_hash": build_password_hash(password),
                    "updated_at": now_utc,
                    "seeded_at": now_utc,
                },
            },
            upsert=True,
        )
        action = "admin_reseeded" if (existing_hash and force_reseed) else "admin_seeded"
        logger.info(action, extra={"event": action, "username": username})
    except Exception as exc:
        logger.error(
            "admin_seed_failed",
            extra={"event": "admin_seed_failed", "error": str(exc)},
        )


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
_seed_admin_account()
_bootstrap_employee_credentials()
_sync_model_artifact_on_boot()
attendance_manager = AttendanceManager(db, on_change=persist_mock_db_now)
face_recognizer = None
if FaceRecognizer is not None and face_recognition is not None:
    face_recognizer = FaceRecognizer(attendance_manager=attendance_manager, model_path=str(MODEL_PATH))
    _load_recognition_settings_from_db()
warning_blueprint = create_warning_blueprint(
    db=db,
    admin_auth_decorator=admin_auth_required,
    persist_callback=persist_mock_db_now,
    logger=logger,
    notification_callback=create_notification,
    audit_callback=log_audit,
)
app.register_blueprint(warning_blueprint)
start_warning_scheduler(db=db, warning_blueprint=warning_blueprint, logger=logger)
model_init_lock = threading.Lock()
model_init_state = {
    "loaded": False,
    "warmed": False,
    "error": None,
}


def _warmup_face_model():
    if face_recognition is None or face_recognizer is None:
        return
    # Trigger detector backend once to avoid first-request cold latency.
    dummy = np.zeros((96, 96, 3), dtype=np.uint8)
    rgb = cv2.cvtColor(dummy, cv2.COLOR_BGR2RGB)
    try:
        face_recognition.face_locations(
            rgb,
            number_of_times_to_upsample=0,
            model=getattr(face_recognizer, "scan_face_detection_model", "hog"),
        )
    except Exception:
        face_recognition.face_locations(rgb, number_of_times_to_upsample=0, model="hog")


def _load_model_once() -> bool:
    if face_recognizer is None:
        return False
    with model_init_lock:
        if model_init_state.get("loaded"):
            return True

        try:
            face_recognizer.load_model()
        except Exception:
            # Deployment-safe fallback: recover model artifact from DB-backed storage
            # and retry load once.
            _sync_model_artifact_on_boot()
            face_recognizer.load_model()
        model_init_state["loaded"] = True
        model_init_state["error"] = None

        try:
            _warmup_face_model()
            model_init_state["warmed"] = True
        except Exception as exc:
            model_init_state["warmed"] = False
            model_init_state["error"] = str(exc)

        return True


def _reload_model_after_training():
    if face_recognizer is None:
        return
    with model_init_lock:
        face_recognizer.load_model()
        model_init_state["loaded"] = True
        model_init_state["error"] = None
        try:
            _warmup_face_model()
            model_init_state["warmed"] = True
        except Exception as exc:
            model_init_state["warmed"] = False
            model_init_state["error"] = str(exc)


def _preload_model_on_startup():
    if face_recognizer is None:
        return
    try:
        _load_model_once()
        logger.info("model_preloaded", extra={"event": "model_preloaded", "app_env": APP_ENV})
    except Exception as exc:
        logger.warning(
            "model_preload_skipped",
            extra={
                "event": "model_preload_skipped",
                "app_env": APP_ENV,
                "detail": str(exc),
            },
        )


_preload_model_on_startup()

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
    if ModelTrainer is None or face_recognition is None:
        _update_train_state(
            job_id=job_id,
            running=False,
            progress=0,
            message="Training unavailable (face recognition disabled)",
            status="failed",
            result=None,
            error="face_recognition_unavailable",
        )
        return
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
        _reload_model_after_training()
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
    try:
        _load_model_once()
    except Exception:
        pass
    model_loaded = bool(len(getattr(face_recognizer, "_known_encodings", []))) if face_recognizer else False
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
            "model_loaded": model_loaded,
            "model_warmed": bool(model_init_state.get("warmed")),
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


@app.get("/debug/env")
@admin_auth_required
def debug_env():
    if not enable_debug_env_endpoint:
        return jsonify({"error": "not_found", "message": "Endpoint disabled"}), 404

    keys = _required_env_keys_for_current_env()
    present = {key: bool(str(os.getenv(key, "")).strip()) for key in keys}
    missing = [key for key, is_present in present.items() if not is_present]

    return jsonify(
        {
            "status": "ok",
            "app_env": APP_ENV,
            "env_file": LOADED_ENV_FILE,
            "db_mode": "mock" if using_mock_db else "mongo",
            "db_name": db_name,
            "cors_allow_all": bool(cors_allow_all),
            "allowed_origins_count": len(cors_origins),
            "required_env": present,
            "missing_env": missing,
            "debug_endpoint_enabled": bool(enable_debug_env_endpoint),
        }
    )


@app.get("/warmup")
def warmup():
    started_at = time.perf_counter()
    try:
        _load_model_once()
        return jsonify(
            {
                "status": "ok",
                "model_loaded": True,
                "model_warmed": bool(model_init_state.get("warmed")),
                "duration_ms": round((time.perf_counter() - started_at) * 1000.0, 2),
                "time": datetime.now().isoformat(),
            }
        )
    except Exception as exc:
        return jsonify(
            {
                "status": "degraded",
                "model_loaded": False,
                "duration_ms": round((time.perf_counter() - started_at) * 1000.0, 2),
                "message": str(exc),
                "time": datetime.now().isoformat(),
            }
        ), 503


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
    """Redirect to frontend or return API info."""
    if DISABLE_BACKEND_UI:
        return redirect(FRONTEND_APP_BASE_URL, code=302)
    return jsonify({
        "service": "Face Attendance API",
        "status": "running",
        "app_env": APP_ENV,
        "frontend": FRONTEND_APP_BASE_URL,
        "endpoints": {
            "health": "/health",
            "ready": "/ready",
            "admin_login": "/admin/login",
            "user_login": "/user/login",
        },
    })


@app.get("/admin")
def admin_login_page():
    """Redirect to frontend admin page."""
    if DISABLE_BACKEND_UI:
        return redirect(f"{FRONTEND_APP_BASE_URL}/#/admin", code=302)
    return jsonify({
        "message": "Use the frontend admin panel or POST to /admin/login",
        "login_endpoint": "/admin/login",
        "frontend_url": f"{FRONTEND_APP_BASE_URL}/#/admin",
    })


@app.get("/user")
def user_login_page():
    """Redirect to frontend user page."""
    if DISABLE_BACKEND_UI:
        return redirect(f"{FRONTEND_APP_BASE_URL}/#/user", code=302)
    return jsonify({
        "message": "Use the frontend user panel or POST to /user/login",
        "login_endpoint": "/user/login",
        "frontend_url": f"{FRONTEND_APP_BASE_URL}/#/user",
    })


# ---------- Item 6: Account lockout after failed login attempts ----------
_login_attempts = {}  # {username: {"count": int, "locked_until": datetime|None, "last_attempt": datetime}}
_LOGIN_MAX_ATTEMPTS = int(os.getenv("LOGIN_MAX_ATTEMPTS", "5"))
_LOGIN_LOCKOUT_MINUTES = int(os.getenv("LOGIN_LOCKOUT_MINUTES", "15"))


def _check_account_lockout(username: str) -> dict:
    """Check if account is locked. Returns {"locked": bool, "remaining_seconds": int}."""
    key = str(username or "").strip().lower()
    if not key or key not in _login_attempts:
        return {"locked": False, "remaining_seconds": 0}
    record = _login_attempts[key]
    locked_until = record.get("locked_until")
    if locked_until and datetime.now(timezone.utc) < locked_until:
        remaining = int((locked_until - datetime.now(timezone.utc)).total_seconds())
        return {"locked": True, "remaining_seconds": max(0, remaining)}
    # Lock expired — reset
    if locked_until and datetime.now(timezone.utc) >= locked_until:
        _login_attempts.pop(key, None)
    return {"locked": False, "remaining_seconds": 0}


def _record_failed_login(username: str):
    """Record a failed login attempt and lock if threshold exceeded."""
    key = str(username or "").strip().lower()
    if not key:
        return
    record = _login_attempts.get(key, {"count": 0, "locked_until": None, "last_attempt": None})
    record["count"] = record.get("count", 0) + 1
    record["last_attempt"] = datetime.now(timezone.utc)
    if record["count"] >= _LOGIN_MAX_ATTEMPTS:
        record["locked_until"] = datetime.now(timezone.utc) + timedelta(minutes=_LOGIN_LOCKOUT_MINUTES)
        logger.warning("account_locked", extra={
            "event": "account_locked",
            "username": key,
            "attempts": record["count"],
            "locked_minutes": _LOGIN_LOCKOUT_MINUTES,
        })
    _login_attempts[key] = record


def _clear_failed_login(username: str):
    """Clear failed login attempts after successful login."""
    key = str(username or "").strip().lower()
    _login_attempts.pop(key, None)


@app.post("/admin/login")
@limiter.limit("10 per minute")
def admin_login():
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username", "") or "").strip()
    password = payload.get("password", "") or ""

    # Check lockout
    lockout = _check_account_lockout(username)
    if lockout["locked"]:
        remaining_min = max(1, lockout["remaining_seconds"] // 60)
        log_audit("admin_login", status="locked", details={"username": username, "remaining_seconds": lockout["remaining_seconds"]})
        return jsonify({
            "success": False,
            "message": f"Account locked due to too many failed attempts. Try again in {remaining_min} minute(s).",
            "locked": True,
            "remaining_seconds": lockout["remaining_seconds"],
        }), 429

    if _verify_admin_password(username, password):
        _clear_failed_login(username)
        token = issue_admin_token(username)
        _touch_admin_session(username, token)
        log_audit("admin_login", details={"username": username})
        return jsonify({"success": True, "token": token})

    _record_failed_login(username)
    log_audit("admin_login", status="failed", details={"username": username})
    return jsonify({"success": False, "message": "Invalid credentials"}), 401


@app.post("/admin/reseed-password")
@limiter.limit("5 per minute")
def admin_reseed_password():
    """Dev-only endpoint to reset the admin password back to env credentials.

    Only works when FLASK_ENV != production and the correct env password is supplied.
    Use this to recover access after forgetting a changed admin password.
    """
    if _is_production_env():
        return jsonify({"success": False, "message": "Not available in production"}), 403

    payload = request.get_json(silent=True) or {}
    env_password = str(os.getenv("ADMIN_PASSWORD", "") or "").strip()
    provided = str(payload.get("env_password") or "").strip()

    if not env_password:
        return jsonify({"success": False, "message": "ADMIN_PASSWORD not set in server env"}), 500
    if provided != env_password:
        return jsonify({"success": False, "message": "env_password does not match server ADMIN_PASSWORD"}), 401

    username = str(os.getenv("ADMIN_USERNAME", "admin") or "admin").strip() or "admin"
    now_utc = datetime.now(timezone.utc)
    default_email = str(os.getenv("ADMIN_EMAIL", f"{username}@local") or f"{username}@local").strip().lower()
    default_name = _default_admin_display_name(username)

    db.admin_accounts.update_one(
        {"username": username},
        {
            "$setOnInsert": {
                "username": username,
                "name": default_name,
                "email": default_email,
                "role": "admin",
                "created_at": now_utc,
            },
            "$set": {
                "password_hash": build_password_hash(env_password),
                "updated_at": now_utc,
                "seeded_at": now_utc,
            },
        },
        upsert=True,
    )
    _login_attempts.pop(username, None)
    log_audit("admin_reseed_password", details={"username": username})
    return jsonify({"success": True, "message": f"Admin password reset to env value for '{username}'"})


@app.post("/user/login")
@limiter.limit("20 per minute")
def user_login():
    payload = request.get_json(silent=True) or {}
    login_id = (payload.get("login_id", "") or "").strip().lower()
    password = payload.get("password", "") or ""

    if not login_id or not password:
        return jsonify({"success": False, "message": "Login ID and password are required"}), 400

    # Check lockout
    lockout = _check_account_lockout(login_id)
    if lockout["locked"]:
        remaining_min = max(1, lockout["remaining_seconds"] // 60)
        log_audit("user_login", status="locked", details={"login_id": login_id})
        return jsonify({
            "success": False,
            "message": f"Account locked due to too many failed attempts. Try again in {remaining_min} minute(s).",
            "locked": True,
            "remaining_seconds": lockout["remaining_seconds"],
        }), 429

    employee = db.employees.find_one({"login_id": login_id})
    if not employee:
        _record_failed_login(login_id)
        log_audit("user_login", status="failed", details={"login_id": login_id, "reason": "not_found"})
        return jsonify({"success": False, "message": "Invalid credentials"}), 401

    password_hash = (employee.get("password_hash") or "").strip()
    if not password_hash or not check_password_hash(password_hash, password):
        _record_failed_login(login_id)
        log_audit("user_login", status="failed", details={"login_id": login_id, "reason": "bad_password"})
        return jsonify({"success": False, "message": "Invalid credentials"}), 401

    _clear_failed_login(login_id)

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


@app.post("/user/validate_login_location")
@user_auth_required
@limiter.limit("240 per hour")
def user_validate_login_location():
    claims = getattr(g, "user_claims", {}) or {}
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        payload = {}

    location_payload = {}
    for key in ("lat", "lng", "accuracy", "location_captured_at_ms", "location_session_jti"):
        if payload.get(key) is not None:
            location_payload[key] = payload.get(key)

    location_check = _validate_scan_location(claims, payload=location_payload, use_accuracy_grace=False)
    if not location_check.get("ok", False):
        code = int(location_check.get("code") or 400)
        response_payload = {
            "allowed": False,
            "status": location_check.get("status") or "location_error",
            "message": location_check.get("message") or "Login not allowed from this location",
        }
        for key in ("distance_m", "allowed_radius_m", "effective_radius_m", "accuracy_m", "location_age_ms"):
            if key in location_check:
                response_payload[key] = location_check.get(key)
        if "details" in location_check:
            response_payload["details"] = location_check.get("details")
        return jsonify(response_payload), code

    response_payload = {
        "allowed": True,
        "status": location_check.get("status") or "ok",
        "message": "Login location verified",
    }
    if location_check.get("enabled"):
        response_payload["location"] = {
            "distance_m": location_check.get("distance_m"),
            "allowed_radius_m": location_check.get("allowed_radius_m"),
            "effective_radius_m": location_check.get("effective_radius_m"),
            "accuracy_m": location_check.get("accuracy_m"),
            "location_age_ms": location_check.get("location_age_ms"),
        }
    return jsonify(response_payload)


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
    username = str(claims.get("sub") or "").strip()
    current_jti = str(claims.get("jti") or "").strip()
    if username and current_jti:
        db.admin_sessions.update_many(
            {"username": username, "jti": current_jti},
            {"$set": {"active": False, "status": "inactive", "updated_at": datetime.now(timezone.utc)}},
        )
    if username:
        _touch_admin_session(username, token)
    return jsonify({"success": True, "token": token})


def _default_admin_display_name(username: str) -> str:
    text = str(username or "").strip()
    if not text:
        return "Administrator"
    return text.replace("_", " ").replace(".", " ").title()


def _ensure_admin_account_doc(username: str) -> dict:
    key = str(username or "").strip()
    if not key:
        key = str(os.getenv("ADMIN_USERNAME", "admin") or "admin").strip() or "admin"
    now_utc = datetime.now(timezone.utc)
    default_email = str(os.getenv("ADMIN_EMAIL", f"{key}@local") or f"{key}@local").strip().lower()
    default_name = str(os.getenv("ADMIN_DISPLAY_NAME", _default_admin_display_name(key)) or _default_admin_display_name(key)).strip()

    db.admin_accounts.update_one(
        {"username": key},
        {
            "$setOnInsert": {
                "username": key,
                "name": default_name,
                "email": default_email,
                "role": "admin",
                "created_at": now_utc,
            },
            "$set": {
                "updated_at": now_utc,
            },
        },
        upsert=True,
    )

    row = db.admin_accounts.find_one({"username": key}) or {}
    if not row.get("name"):
        row["name"] = default_name
    if not row.get("email"):
        row["email"] = default_email
    if not row.get("role"):
        row["role"] = "admin"
    return row


def _verify_admin_password(username: str, password: str) -> bool:
    key = str(username or "").strip()
    if not key:
        return False

    row = db.admin_accounts.find_one({"username": key}) or {}
    password_hash = str(row.get("password_hash") or "").strip()
    if password_hash:
        try:
            return check_password_hash(password_hash, str(password or ""))
        except Exception:
            return False

    return verify_admin_credentials(key, str(password or ""))


def _session_device_from_user_agent(user_agent_text: str) -> str:
    text = str(user_agent_text or "").lower()
    if not text:
        return "Unknown Device"
    if "iphone" in text or "ipad" in text or "android" in text or "mobile" in text:
        return "Mobile"
    if "mac" in text:
        return "Mac"
    if "windows" in text:
        return "Windows"
    if "linux" in text:
        return "Linux"
    return "Browser"


def _touch_admin_session(username: str, token: str, claims: Optional[dict] = None):
    key = str(username or "").strip()
    if not key:
        return

    parsed_claims = claims or {}
    if not parsed_claims:
        try:
            parsed_claims = decode_admin_token(token)
        except Exception:
            parsed_claims = {}

    jti = str(parsed_claims.get("jti") or "").strip()
    if not jti:
        return

    exp = parsed_claims.get("exp")
    try:
        expires_at = datetime.fromtimestamp(float(exp), tz=timezone.utc) if exp else (datetime.now(timezone.utc) + timedelta(days=7))
    except Exception:
        expires_at = datetime.now(timezone.utc) + timedelta(days=7)

    now_utc = datetime.now(timezone.utc)
    user_agent_text = str(request.headers.get("User-Agent") or "").strip()
    ip_text = (
        str(request.headers.get("X-Forwarded-For") or "").split(",", 1)[0].strip()
        or str(request.headers.get("X-Real-IP") or "").strip()
        or str(request.remote_addr or "").strip()
        or "unknown"
    )
    location_text = str(request.headers.get("X-Client-Location") or request.headers.get("X-Geo-City") or "Unknown").strip() or "Unknown"

    db.admin_sessions.update_one(
        {"username": key, "jti": jti},
        {
            "$setOnInsert": {
                "id": jti,
                "username": key,
                "jti": jti,
                "created_at": now_utc,
            },
            "$set": {
                "device": _session_device_from_user_agent(user_agent_text),
                "user_agent": user_agent_text,
                "ip": ip_text,
                "location": location_text,
                "status": "active",
                "active": True,
                "last_seen_at": now_utc,
                "expires_at": expires_at,
                "updated_at": now_utc,
            },
        },
        upsert=True,
    )


def _serialize_admin_session(row: dict, current_jti: str = "") -> dict:
    now_utc = datetime.now(timezone.utc)
    expires_at = row.get("expires_at")
    is_expired = False
    if isinstance(expires_at, datetime):
        expires_cmp = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
        is_expired = expires_cmp <= now_utc
    is_active = bool(row.get("active", True)) and not is_expired
    status = "active" if is_active else "inactive"

    def _iso(value):
        if isinstance(value, datetime):
            return value.isoformat()
        return str(value or "")

    return {
        "id": str(row.get("id") or row.get("jti") or ""),
        "device": str(row.get("device") or "Unknown Device"),
        "location": str(row.get("location") or "Unknown"),
        "status": status,
        "ip": str(row.get("ip") or "unknown"),
        "created_at": _iso(row.get("created_at")),
        "last_seen_at": _iso(row.get("last_seen_at")),
        "expires_at": _iso(row.get("expires_at")),
        "is_current": str(row.get("jti") or "") == str(current_jti or ""),
    }


def _current_admin_username() -> str:
    claims = getattr(g, "admin_claims", {}) or {}
    return str(claims.get("sub") or os.getenv("ADMIN_USERNAME", "admin") or "admin").strip() or "admin"


@app.get("/api/account/profile")
@admin_auth_required
def api_account_profile_get():
    username = _current_admin_username()
    row = _ensure_admin_account_doc(username)
    return jsonify({
        "profile": {
            "username": username,
            "name": str(row.get("name") or _default_admin_display_name(username)),
            "email": str(row.get("email") or f"{username}@local"),
            "role": str(row.get("role") or "admin"),
            "created_at": row.get("created_at").isoformat() if isinstance(row.get("created_at"), datetime) else "",
        }
    })


@app.put("/api/account/profile")
@admin_auth_required
@limiter.limit("120 per hour")
def api_account_profile_update():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()
    if not name:
        return jsonify({"message": "Name is required"}), 400

    username = _current_admin_username()
    row = _ensure_admin_account_doc(username)
    now_utc = datetime.now(timezone.utc)

    db.admin_accounts.update_one(
        {"username": username},
        {
            "$set": {
                "name": name,
                "updated_at": now_utc,
            },
            "$setOnInsert": {
                "username": username,
                "email": str(row.get("email") or f"{username}@local").strip().lower(),
                "role": "admin",
                "created_at": now_utc,
            },
        },
        upsert=True,
    )
    updated = db.admin_accounts.find_one({"username": username}) or {}
    log_audit("account_profile_update", target={"username": username})
    return jsonify({
        "message": "Profile updated successfully",
        "profile": {
            "username": username,
            "name": str(updated.get("name") or name),
            "email": str(updated.get("email") or f"{username}@local"),
            "role": str(updated.get("role") or "admin"),
            "created_at": updated.get("created_at").isoformat() if isinstance(updated.get("created_at"), datetime) else "",
        },
    })


@app.post("/api/account/change-password")
@admin_auth_required
@limiter.limit("20 per minute")
def api_account_change_password():
    payload = request.get_json(silent=True) or {}
    old_password = str(payload.get("old_password") or "")
    new_password = str(payload.get("new_password") or "")

    if not old_password or not new_password:
        return jsonify({"message": "Old password and new password are required"}), 400
    if len(new_password) < 6:
        return jsonify({"message": "New password must be at least 6 characters"}), 400

    username = _current_admin_username()
    row = _ensure_admin_account_doc(username)
    existing_hash = str(row.get("password_hash") or "").strip()

    if existing_hash:
        old_ok = check_password_hash(existing_hash, old_password)
    else:
        old_ok = verify_admin_credentials(username, old_password)

    if not old_ok:
        log_audit("account_change_password", status="failed", details={"username": username, "reason": "incorrect_old_password"})
        return jsonify({"message": "Old password is incorrect"}), 401

    now_utc = datetime.now(timezone.utc)
    db.admin_accounts.update_one(
        {"username": username},
        {
            "$set": {
                "password_hash": build_password_hash(new_password),
                "updated_at": now_utc,
                "password_updated_at": now_utc,
            },
            "$setOnInsert": {
                "username": username,
                "name": str(row.get("name") or _default_admin_display_name(username)),
                "email": str(row.get("email") or f"{username}@local").strip().lower(),
                "role": "admin",
                "created_at": now_utc,
            },
        },
        upsert=True,
    )

    claims = getattr(g, "admin_claims", {}) or {}
    current_jti = str(claims.get("jti") or "").strip()
    if current_jti:
        db.admin_sessions.update_many(
            {"username": username, "jti": current_jti},
            {"$set": {"active": False, "status": "inactive", "updated_at": now_utc}},
        )

    new_token = issue_admin_token(username)
    _touch_admin_session(username, new_token)
    log_audit("account_change_password", target={"username": username})
    return jsonify({"message": "Password updated successfully", "token": new_token})


@app.get("/api/account/sessions")
@admin_auth_required
def api_account_sessions():
    username = _current_admin_username()
    claims = getattr(g, "admin_claims", {}) or {}
    current_jti = str(claims.get("jti") or "").strip()

    auth_header = str(request.headers.get("Authorization") or "")
    active_token = ""
    if auth_header.startswith("Bearer "):
        active_token = auth_header.split(" ", 1)[1].strip()
    if active_token:
        _touch_admin_session(username, active_token, claims=claims)

    rows = list(db.admin_sessions.find({"username": username}).sort("last_seen_at", -1).limit(50))
    return jsonify({
        "items": [_serialize_admin_session(row, current_jti=current_jti) for row in rows],
        "total": len(rows),
    })


@app.post("/api/account/sessions/logout-others")
@admin_auth_required
@limiter.limit("60 per hour")
def api_account_sessions_logout_others():
    username = _current_admin_username()
    claims = getattr(g, "admin_claims", {}) or {}
    current_jti = str(claims.get("jti") or "").strip()
    if not current_jti:
        return jsonify({"message": "Invalid admin session"}), 401

    now_utc = datetime.now(timezone.utc)
    result = db.admin_sessions.update_many(
        {"username": username, "jti": {"$ne": current_jti}},
        {"$set": {"active": False, "status": "inactive", "updated_at": now_utc}},
    )
    log_audit("account_logout_other_devices", target={"username": username}, details={"count": int(result.modified_count or 0)})
    return jsonify({
        "message": "Other devices logged out successfully",
        "updated": int(result.modified_count or 0),
    })


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

    date_str = ist_now().strftime("%Y-%m-%d")
    attendance_manager.auto_mark_absent_for_date(date_str)
    row = db.attendance.find_one({"employee_id": oid, "date": date_str})

    if not row:
        return jsonify({
            "status": "not_checked_in",
            "date": date_str,
            "checked_in": False,
            "check_in": None,
            "check_out": None,
            "timing_status": None,
        })

    row = normalize_attendance_row_times(row)
    raw_status = str(row.get("status") or "").strip().lower()
    raw_timing_status = str(row.get("timing_status") or "").strip().lower()
    is_leave = bool(row.get("leave_marked")) or raw_status == "leave" or raw_timing_status == "on leave"
    is_absent = bool(row.get("auto_absent")) or raw_status == "absent"
    status = "leave_marked" if is_leave else ("absent" if is_absent else ("checked_out" if row.get("check_out") else "checked_in"))
    return jsonify({
        "status": status,
        "date": row.get("date") or date_str,
        "checked_in": (not is_leave) and (not is_absent),
        "check_in": row.get("check_in"),
        "check_out": row.get("check_out"),
        "check_in_at": row.get("check_in_at"),
        "check_out_at": row.get("check_out_at"),
        "timing_status": "On Leave" if is_leave else ("Absent" if is_absent else (row.get("timing_status") or row.get("exit_status") or row.get("entry_status"))),
    })


@app.post("/user/mark_entry_on_login")
@user_auth_required
@limiter.limit("120 per hour")
def user_mark_entry_on_login():
    claims = getattr(g, "user_claims", {}) or {}
    employee_id = str(claims.get("employee_id") or "").strip()
    employee_name = _get_cached_employee_name(employee_id) if employee_id else ""
    if not employee_name:
        employee_name = str(claims.get("employee_name") or "").strip()

    if not employee_name:
        return jsonify({"status": "error", "message": "Invalid user token"}), 401

    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        payload = {}

    location_payload = {}
    for key in ("lat", "lng", "accuracy", "location_captured_at_ms", "location_session_jti"):
        if payload.get(key) is not None:
            location_payload[key] = payload.get(key)

    location_check = _validate_scan_location(claims, payload=location_payload, use_accuracy_grace=False)
    if not location_check.get("ok", False):
        code = int(location_check.get("code") or 400)
        response_payload = {
            "status": location_check.get("status") or "location_error",
            "message": location_check.get("message") or "Punch in not allowed from this location",
        }
        for key in ("distance_m", "allowed_radius_m", "effective_radius_m", "accuracy_m", "location_age_ms"):
            if key in location_check:
                response_payload[key] = location_check.get(key)
        if "details" in location_check:
            response_payload["details"] = location_check.get("details")
        return jsonify(response_payload), code

    result = attendance_manager.mark_entry(employee_name, source="login")
    if result.get("status") == "error":
        return jsonify(result), 400

    today_str = ist_now().strftime("%Y-%m-%d")
    employee_tasks = list(db.tasks.find({"assigned_to": employee_id}).sort("deadline", 1))
    today_tasks = []
    for row in employee_tasks:
        serialized = _serialize_task(row)
        deadline_text = str(serialized.get("deadline") or "")[:10]
        if deadline_text == today_str:
            today_tasks.append(serialized)
    result["today_tasks"] = today_tasks

    code = 200
    if result.get("status") == "checked_in":
        log_audit("user_login_entry_marked", target={"employee_id": employee_id, "login_id": claims.get("login_id")})
        create_notification(
            f"You have successfully checked in. Have a productive day!",
            "attendance",
            employee_id,
            title="Checked In",
            priority="low",
            category="attendance_correction_approved",
        )

    return jsonify(result), code


@app.post("/user/mark_exit_on_logout")
@user_auth_required
@limiter.limit("120 per hour")
def user_mark_exit_on_logout():
    claims = getattr(g, "user_claims", {}) or {}
    employee_id = str(claims.get("employee_id") or "").strip()
    employee_name = _get_cached_employee_name(employee_id) if employee_id else ""
    if not employee_name:
        employee_name = str(claims.get("employee_name") or "").strip()

    if not employee_name:
        return jsonify({"status": "error", "message": "Invalid user token"}), 401

    result = attendance_manager.mark_exit(employee_name, source="logout")
    if result.get("status") == "error":
        return jsonify(result), 400

    today_str = ist_now().strftime("%Y-%m-%d")
    employee_tasks = [_serialize_task(row) for row in db.tasks.find({"assigned_to": employee_id})]
    completed_today = [
        t for t in employee_tasks
        if str(t.get("status") or "") in {"completed", "approved"} and str(t.get("completed_at") or t.get("approved_at") or "")[:10] == today_str
    ]
    pending_tasks = [t for t in employee_tasks if str(t.get("status") or "") not in {"completed", "approved"}]

    hours_worked = 0.0
    try:
        check_in_at = datetime.fromisoformat(str(result.get("check_in_at") or "").replace("Z", "+00:00"))
        check_out_at = datetime.fromisoformat(str(result.get("check_out_at") or "").replace("Z", "+00:00"))
        delta = check_out_at - check_in_at
        hours_worked = round(max(0.0, delta.total_seconds() / 3600.0), 2)
    except Exception:
        hours_worked = 0.0

    result["productivity"] = {
        "tasks_completed_today": len(completed_today),
        "pending_tasks": len(pending_tasks),
        "hours_worked": hours_worked,
    }

    if result.get("status") == "checked_out":
        log_audit("user_logout_exit_marked", target={"employee_id": employee_id, "login_id": claims.get("login_id")})
        create_notification(
            f"You have successfully checked out. See you tomorrow!",
            "attendance",
            employee_id,
            title="Checked Out",
            priority="low",
            category="attendance_correction_approved",
        )

    return jsonify(result), 200


@app.post("/user/mark_leave")
@user_auth_required
@limiter.limit("60 per hour")
def user_mark_leave():
    claims = getattr(g, "user_claims", {}) or {}
    employee_id = str(claims.get("employee_id") or "").strip()
    employee_name = _get_cached_employee_name(employee_id) if employee_id else ""
    if not employee_name:
        employee_name = str(claims.get("employee_name") or "").strip()

    if not employee_name:
        return jsonify({"status": "error", "message": "Invalid user token"}), 401

    result = attendance_manager.mark_leave(employee_name, source="employee_panel")
    if result.get("status") == "error":
        return jsonify(result), 400
    if result.get("status") == "attendance_exists":
        return jsonify(result), 409

    if result.get("status") == "leave_marked":
        log_audit("user_leave_marked", target={"employee_id": employee_id, "login_id": claims.get("login_id")})
        create_notification(
            f"Your leave has been marked for today. Rest well!",
            "attendance",
            employee_id,
            title="Leave Marked",
            priority="low",
            category="attendance_correction_approved",
        )

    return jsonify(result), 200


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
    try:
        employee_folder = ensure_dir(DATASET_PATH / folder_name)
    except Exception:
        logger.exception("register_employee_storage_unavailable")
        return jsonify({"message": "Employee image storage is not writable. Check DATASET_PATH/volume mount."}), 500

    saved_files = []
    skipped_files = []
    for file in files:
        if not file or not file.filename:
            continue
        if not is_image_file(file.filename):
            continue

        filename = Path(file.filename).name
        target = employee_folder / filename
        try:
            file.save(target)
        except Exception:
            skipped_files.append(
                {
                    "file": filename,
                    "reason": "Unable to save image to server storage",
                }
            )
            continue

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

    # Ensure images are not only detectable, but also encodable for model training.
    # This prevents enroll-success + train-fail loops when blurry/low-detail frames are captured.
    if len(saved_files) > 0:
        encodable_files = []
        for path_str in list(saved_files):
            path_obj = Path(path_str)
            try:
                img = face_recognition.load_image_file(str(path_obj))
                enc = face_recognition.face_encodings(img, num_jitters=1, model="small")
                if len(enc) < 1:
                    path_obj.unlink(missing_ok=True)
                    skipped_files.append(
                        {
                            "file": path_obj.name,
                            "reason": "Face not encodable. Capture a clearer front-facing image.",
                        }
                    )
                    continue
                encodable_files.append(path_str)
            except Exception:
                path_obj.unlink(missing_ok=True)
                skipped_files.append(
                    {
                        "file": path_obj.name,
                        "reason": "Face encoding failed. Capture again in better lighting.",
                    }
                )
                continue

        saved_files = encodable_files

    existing = db.employees.find_one({"name": folder_name})
    credentials_only_enrollment = len(saved_files) == 0 and allow_credentials_only_enrollment and not require_face_images

    if len(saved_files) == 0 and not credentials_only_enrollment:
        return (
            jsonify(
                {
                    "message": "No valid face encodings found. Capture again with clear front-facing face and better lighting.",
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

    is_new_employee = not bool(existing)

    if existing:
        conflict = db.employees.find_one({"login_id": login_id, "_id": {"$ne": existing["_id"]}})
        if conflict:
            return jsonify({"message": "Login ID already exists"}), 409

        try:
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
        except DuplicateKeyError:
            return jsonify({"message": "Login ID already exists"}), 409
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
        try:
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
        except DuplicateKeyError:
            return jsonify({"message": "Login ID already exists"}), 409

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

    if is_new_employee:
        create_notification(
            f"Employee added: {folder_name}",
            "employee",
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

    json_payload = request.get_json(silent=True) if request.is_json else {}
    if not isinstance(json_payload, dict):
        json_payload = {}

    form_payload = request.form.to_dict(flat=True) if request.form else {}
    scan_payload = dict(form_payload)
    for key in ("lat", "lng", "accuracy", "location_captured_at_ms", "location_session_jti", "image_base64", "challenge_id"):
        if key not in scan_payload and json_payload.get(key) is not None:
            scan_payload[key] = json_payload.get(key)

    logger.info(
        "scan_attendance_request",
        extra={
            "event": "scan_attendance_request",
            "request_id": getattr(g, "request_id", None),
            "method": request.method,
            "path": request.path,
            "app_env": APP_ENV,
            "content_type": request.headers.get("Content-Type"),
            "content_length": request.content_length,
            "form_keys": sorted(list(form_payload.keys())),
            "file_keys": sorted(list(request.files.keys())),
        },
    )


    location_check = _validate_scan_location(claims, payload=scan_payload)
    if not location_check.get("ok", False):
        code = int(location_check.get("code") or 400)
        payload = {
            "status": location_check.get("status") or "location_error",
            "message": location_check.get("message") or "Location validation failed",
        }
        for key in ("distance_m", "allowed_radius_m", "effective_radius_m", "accuracy_m", "location_age_ms"):
            if key in location_check:
                payload[key] = location_check[key]
        if "details" in location_check:
            payload["details"] = location_check.get("details")
        logger.warning(
            "scan_attendance_location_validation_failed",
            extra={
                "event": "scan_attendance_location_validation_failed",
                "request_id": getattr(g, "request_id", None),
                "method": request.method,
                "path": request.path,
                "app_env": APP_ENV,
                "validation_error": payload.get("status"),
            },
        )
        return jsonify(payload), code

    challenge_id = str(scan_payload.get("challenge_id") or request.form.get("challenge_id") or "").strip()
    challenge_action = None
    challenge_instruction = None
    if challenge_id:
        challenge_check = _consume_scan_challenge(challenge_id, claims)
        if challenge_check.get("ok"):
            challenge_action = challenge_check.get("action")
            challenge_instruction = challenge_check.get("instruction")

    image_file = request.files.get("image")
    uploaded_image_present = bool(image_file)
    raw = None
    if image_file:
        raw = image_file.read()
    elif scan_payload.get("image_base64"):
        image_base64 = str(scan_payload.get("image_base64") or "").strip()
        if image_base64.startswith("data:image") and "," in image_base64:
            image_base64 = image_base64.split(",", 1)[1]
        try:
            raw = base64.b64decode(image_base64, validate=True)
        except (binascii.Error, ValueError):
            logger.warning(
                "scan_attendance_invalid_image_base64",
                extra={
                    "event": "scan_attendance_invalid_image_base64",
                    "request_id": getattr(g, "request_id", None),
                    "method": request.method,
                    "path": request.path,
                    "app_env": APP_ENV,
                    "validation_error": "invalid_image_base64",
                },
            )
            return (
                jsonify(
                    {
                        "error": "validation_error",
                        "status": "wrong_data",
                        "message": "Invalid image_base64 payload",
                        "details": {
                            "required_fields": ["image"],
                            "accepted_content_types": ["multipart/form-data", "application/json"],
                        },
                    }
                ),
                400,
            )

    if uploaded_image_present and raw == b"":
        return jsonify({"error": "validation_error", "status": "wrong_data", "message": "Empty image"}), 400

    if not raw:
        logger.warning(
            "scan_attendance_missing_image",
            extra={
                "event": "scan_attendance_missing_image",
                "request_id": getattr(g, "request_id", None),
                "method": request.method,
                "path": request.path,
                "app_env": APP_ENV,
                "validation_error": "missing_image",
            },
        )
        return (
            jsonify(
                {
                    "error": "validation_error",
                    "status": "wrong_data",
                    "message": "Image is required. Send multipart/form-data with field 'image' (file) or JSON field 'image_base64'.",
                    "details": {
                        "required_fields": ["image", "lat", "lng"],
                        "received_form_fields": sorted(list(form_payload.keys())),
                        "received_file_fields": sorted(list(request.files.keys())),
                        "content_type": request.headers.get("Content-Type"),
                    },
                }
            ),
            400,
        )

    cache_digest = hashlib.sha1(raw).hexdigest()
    cache_key = f"{claims.get('employee_id') or claims.get('login_id')}:{cache_digest}"
    cached = _get_scan_result_cache(cache_key)
    if cached:
        cached["location"] = {
            "verified": True,
            "distance_m": location_check.get("distance_m"),
            "allowed_radius_m": location_check.get("allowed_radius_m"),
            "effective_radius_m": location_check.get("effective_radius_m"),
            "accuracy_m": location_check.get("accuracy_m"),
            "location_age_ms": location_check.get("location_age_ms"),
        }
        return jsonify(cached), 200

    arr = np.frombuffer(raw, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return jsonify({"status": "wrong_data", "message": "Invalid image format"}), 400

    try:
        expected_name = claims.get("employee_name")
        employee_id = claims.get("employee_id")
        if employee_id:
            expected_name = _get_cached_employee_name(str(employee_id))
            if not expected_name:
                return jsonify({"status": "wrong_data", "message": "Invalid user session"}), 401

        if not str(expected_name or "").strip():
            return jsonify({"status": "wrong_data", "message": "Invalid user session"}), 401

        scan_api_start = time.perf_counter()
        result = face_recognizer.scan_frame(
            frame,
            expected_name=expected_name,
            challenge_action=challenge_action,
        )
        scan_api_ms = round((time.perf_counter() - scan_api_start) * 1000, 1)
        logger.info(
            "scan_frame_completed",
            extra={
                "event": "scan_frame",
                "request_id": getattr(g, "request_id", None),
                "expected_name": expected_name,
                "result_status": result.get("status"),
                "match_distance": result.get("match_distance"),
                "scan_time_ms": result.get("scan_time_ms"),
                "api_overhead_ms": round(scan_api_ms - (result.get("scan_time_ms") or 0), 1),
            },
        )

        normalized_expected = str(expected_name or "").strip().lower()
        normalized_detected = str(result.get("employee_name") or "").strip().lower()
        if (
            normalized_expected
            and normalized_detected
            and normalized_expected != normalized_detected
            and result.get("status") in {"checked_in", "checked_out", "already_recorded"}
        ):
            return jsonify({"status": "wrong_data", "message": "User not match"}), 401

        if location_check.get("enabled"):
            result["location"] = {
                "verified": True,
                "distance_m": location_check.get("distance_m"),
                "allowed_radius_m": location_check.get("allowed_radius_m"),
                "effective_radius_m": location_check.get("effective_radius_m"),
                "accuracy_m": location_check.get("accuracy_m"),
                "location_age_ms": location_check.get("location_age_ms"),
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
        if result.get("status") in {"checked_in", "checked_out", "already_recorded"}:
            _set_scan_result_cache(cache_key, result)
        if result.get("status") in {"checked_in", "checked_out"}:
            action = "checked in" if result.get("status") == "checked_in" else "checked out"
            notif_title = "Checked In" if result.get("status") == "checked_in" else "Checked Out"
            notif_msg = "You have successfully checked in. Have a productive day!" if result.get("status") == "checked_in" else "You have successfully checked out. See you tomorrow!"
            create_notification(
                notif_msg,
                "attendance",
                str(employee_id or ""),
                title=notif_title,
                priority="low",
                category="attendance_correction_approved",
            )
        result_message = str(result.get("message") or "")
        if result.get("status") != "wrong_data":
            code = 200
        elif result_message == "User not match":
            code = 401
        elif result_message == "No registered users found":
            code = 400
        else:
            code = 422
        if code == 422:
            return (
                jsonify(
                    {
                        "error": "scan_validation_failed",
                        **result,
                        "details": {
                            "hint": "Ensure your face is centered, well lit, and clearly visible to camera.",
                            "expected_payload": {
                                "content_type": "multipart/form-data",
                                "fields": ["image", "lat", "lng", "accuracy", "location_captured_at_ms", "location_session_jti"],
                            },
                        },
                    }
                ),
                422,
            )
        return jsonify(result), code
    except Exception as e:
        logger.exception(
            "scan_attendance_exception",
            extra={
                "event": "scan_attendance_exception",
                "request_id": getattr(g, "request_id", None),
                "method": request.method,
                "path": request.path,
                "app_env": APP_ENV,
            },
        )
        return jsonify({"error": "scan_processing_error", "status": "wrong_data", "message": str(e)}), 400


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
    leave_type = str(payload.get("leave_type") or "").strip().lower()
    issue_type = str(payload.get("issue_type") or "").strip().lower()
    expected_check_in = str(payload.get("expected_check_in") or "").strip()
    expected_check_out = str(payload.get("expected_check_out") or "").strip()
    from_date = str(payload.get("from_date") or payload.get("date") or ist_now().strftime("%Y-%m-%d")).strip()
    to_date = str(payload.get("to_date") or from_date).strip()
    emergency_contact = str(payload.get("emergency_contact") or "").strip()
    emergency_comment = str(payload.get("emergency_comment") or "").strip()
    request_source = str(payload.get("source") or "employee_panel").strip().lower() or "employee_panel"
    half_day = str(payload.get("half_day") or "").strip().lower() in {"1", "true", "yes", "on"}

    if request_type not in {"outside_office", "wfh", "other", "leave"}:
        return jsonify({"message": "Invalid request type"}), 400

    if request_type == "leave" and leave_type not in {
        "sick_leave",
        "casual_leave",
        "paid_leave",
        "emergency_leave",
        "half_day",
        "work_from_home",
    }:
        return jsonify({"message": "Invalid leave type"}), 400

    if request_type == "leave" and leave_type == "work_from_home":
        request_type = "wfh"
        work_mode = "wfh"

    if request_type == "wfh" and not leave_type:
        leave_type = "work_from_home"

    if work_mode not in {"office", "wfh"}:
        return jsonify({"message": "Invalid work mode"}), 400

    if not reason:
        return jsonify({"message": "Reason is required"}), 400

    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found. Use registered employee name"}), 404

    employee_oid = employee.get("_id")
    if employee_oid is None:
        return jsonify({"message": "Employee record missing id"}), 500

    try:
        from_dt = datetime.strptime(from_date, "%Y-%m-%d")
        to_dt = datetime.strptime(to_date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"message": "Invalid date format. Use YYYY-MM-DD."}), 400

    if to_dt < from_dt:
        return jsonify({"message": "To date cannot be before from date"}), 400

    if (to_dt - from_dt).days > 60:
        return jsonify({"message": "Leave request range cannot exceed 60 days"}), 400

    date_str = from_date
    if request_source not in {"reimbursement", "payroll_reimbursement"} and request_type != "leave" and request_type != "wfh":
        existing_attendance = db.attendance.find_one({"employee_id": employee_oid, "date": date_str})
        if existing_attendance:
            return jsonify({
                "status": "attendance_exists",
                "message": "Attendance already marked for today. Manual request not allowed",
                "date": date_str,
            }), 409

        pending_request = db.manual_requests.find_one(
            {
                "employee_id": employee_oid,
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
    else:
        overlap_pending = db.manual_requests.find_one(
            {
                "employee_id": employee_oid,
                "status": "pending",
                "request_type": {"$in": ["leave", "wfh"]},
                "$or": [
                    {
                        "from_date": {"$lte": to_date},
                        "to_date": {"$gte": from_date},
                    },
                    {
                        "date": {"$gte": from_date, "$lte": to_date},
                    },
                ],
            }
        )
        if overlap_pending:
            return jsonify({
                "status": "manual_request_pending",
                "message": "Overlapping leave request already pending",
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

    image_path = ""
    attachment_path = ""
    image_file = request.files.get("image")
    attachment_file = request.files.get("attachment")
    if image_file and image_file.filename:
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
    elif request_type == "outside_office" and not attachment_file:
        return jsonify({"message": "Camera image is required for manual request"}), 400

    if attachment_file and attachment_file.filename:
        safe_name = _safe_asset_filename(attachment_file.filename)
        if not safe_name:
            safe_name = f"leave_attachment_{uuid.uuid4().hex}.bin"
        target = MANUAL_REQUESTS_IMAGE_DIR / f"attachment_{uuid.uuid4().hex}_{safe_name}"
        attachment_file.save(str(target))
        attachment_path = str(target)

    now = ist_now()
    doc = {
        "employee_id": employee_oid,
        "employee_name": employee_name,
        "date": date_str,
        "request_type": request_type,
        "work_mode": work_mode,
        "issue_type": issue_type,
        "source": request_source,
        "leave_type": leave_type,
        "from_date": from_date,
        "to_date": to_date,
        "half_day": bool(half_day or leave_type == "half_day"),
        "emergency_contact": emergency_contact,
        "emergency_comment": emergency_comment,
        "expected_check_in": expected_check_in,
        "expected_check_out": expected_check_out,
        "reason": reason,
        "status": "pending",
        "location": location,
        "image_path": image_path,
        "attachment_path": attachment_path,
        "created_at": now,
        "updated_at": now,
    }

    result = db.manual_requests.insert_one(doc)
    persist_mock_db_now()
    created = db.manual_requests.find_one({"_id": result.inserted_id})
    create_notification(
        f"{employee_name} submitted a {request_type} request",
        "request",
    )
    return jsonify({"message": "Manual request submitted", "request": _serialize_manual_request(created)}), 201


@app.get("/manual_requests")
@admin_auth_required
def list_manual_requests():
    status = (request.args.get("status") or "").strip().lower()
    employee_id = str(request.args.get("employee_id") or "").strip()
    company_id = str(request.args.get("company_id") or "").strip()
    query = {"status": status} if status else {}
    if employee_id:
        from bson import ObjectId
        from bson.errors import InvalidId
        try:
            query["employee_id"] = ObjectId(employee_id)
        except InvalidId:
            return jsonify({"message": "Invalid employee id"}), 400

    if company_id:
        company_employee_ids = _get_company_employee_ids(company_id)
        if "employee_id" not in query:
            query["employee_id"] = {"$in": company_employee_ids}

    rows = list(db.manual_requests.find(query).sort("created_at", -1))
    return jsonify([_serialize_manual_request(row) for row in rows])


def _merged_leave_allowances(employee_row: Optional[dict]) -> dict:
    """Leave caps consumed by `/user/leave_requests`; env defaults unless employee.leave_quotas overrides."""
    employee_row = employee_row or {}
    defaults = {
        "casual_leave": int(os.getenv("LEAVE_QUOTA_CASUAL", "12") or 12),
        "sick_leave": int(os.getenv("LEAVE_QUOTA_SICK", "10") or 10),
        "paid_leave": int(os.getenv("LEAVE_QUOTA_PAID", "15") or 15),
        "work_from_home": int(os.getenv("LEAVE_QUOTA_WFH", "24") or 24),
    }
    raw_lq = employee_row.get("leave_quotas") if isinstance(employee_row.get("leave_quotas"), dict) else {}
    out = dict(defaults)
    for key in ("casual_leave", "sick_leave", "paid_leave", "work_from_home"):
        if key not in raw_lq:
            continue
        try:
            out[key] = max(0, int(raw_lq.get(key)))
        except (TypeError, ValueError):
            pass
    return out


def _sanitize_leave_quotas_document(raw: object) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    out = {}
    for key in ("casual_leave", "sick_leave", "paid_leave", "work_from_home"):
        if key not in raw:
            continue
        try:
            out[key] = max(0, int(raw[key]))
        except (TypeError, ValueError):
            continue
    return out or None


@app.get("/user/leave_requests")
@user_auth_required
@limiter.limit("120 per hour")
def user_leave_requests():
    claims = getattr(g, "user_claims", {}) or {}
    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    employee_oid = employee.get("_id")
    rows = list(
        db.manual_requests.find(
            {
                "employee_id": employee_oid,
                "request_type": {"$in": ["leave", "wfh"]},
            }
        ).sort("created_at", -1)
    )
    serialized = [_serialize_manual_request(row) for row in rows]

    def _request_duration_days(item: dict) -> float:
        leave_type = str(item.get("leave_type") or "").strip().lower()
        if leave_type == "half_day" or bool(item.get("half_day")):
            return 0.5

        start_text = str(item.get("from_date") or item.get("date") or "").strip()
        end_text = str(item.get("to_date") or start_text).strip()
        try:
            start_dt = datetime.strptime(start_text, "%Y-%m-%d")
            end_dt = datetime.strptime(end_text, "%Y-%m-%d")
            if end_dt < start_dt:
                return 0
            return float((end_dt - start_dt).days + 1)
        except Exception:
            return 1.0 if start_text else 0

    allowances = _merged_leave_allowances(employee)

    consumed = {
        "casual_leave": 0.0,
        "sick_leave": 0.0,
        "paid_leave": 0.0,
        "work_from_home": 0.0,
        "half_day": 0.0,
    }
    pending_used = {
        "casual_leave": 0.0,
        "sick_leave": 0.0,
        "paid_leave": 0.0,
        "work_from_home": 0.0,
    }

    for item in serialized:
        leave_type = str(item.get("leave_type") or "").strip().lower()
        if str(item.get("request_type") or "").strip().lower() == "wfh" and not leave_type:
            leave_type = "work_from_home"
        duration = _request_duration_days(item)
        status = str(item.get("status") or "").strip().lower()
        if status == "approved":
            if leave_type in consumed:
                consumed[leave_type] += duration
        elif status == "pending" and leave_type in pending_used:
            pending_used[leave_type] += duration

    balance = {
        "casual_leave_total": float(allowances["casual_leave"]),
        "sick_leave_total": float(allowances["sick_leave"]),
        "paid_leave_total": float(allowances["paid_leave"]),
        "work_from_home_total": float(allowances["work_from_home"]),
        "casual_leave_used": consumed["casual_leave"],
        "sick_leave_used": consumed["sick_leave"],
        "paid_leave_used": consumed["paid_leave"],
        "work_from_home_used": consumed["work_from_home"],
        "casual_leave_pending": pending_used["casual_leave"],
        "sick_leave_pending": pending_used["sick_leave"],
        "paid_leave_pending": pending_used["paid_leave"],
        "work_from_home_pending": pending_used["work_from_home"],
        "casual_leave_remaining": max(0.0, allowances["casual_leave"] - consumed["casual_leave"]),
        "sick_leave_remaining": max(0.0, allowances["sick_leave"] - consumed["sick_leave"]),
        "paid_leave_remaining": max(0.0, allowances["paid_leave"] - consumed["paid_leave"]),
        "work_from_home_remaining": max(0.0, allowances["work_from_home"] - consumed["work_from_home"]),
        "half_day_used": consumed["half_day"],
    }

    return jsonify({
        "history": serialized,
        "balance": balance,
        "totals": {
            "pending": len([item for item in serialized if str(item.get("status") or "").lower() == "pending"]),
            "approved": len([item for item in serialized if str(item.get("status") or "").lower() == "approved"]),
            "rejected": len([item for item in serialized if str(item.get("status") or "").lower() == "rejected"]),
        },
    })


@app.get("/user/correction_requests")
@user_auth_required
@limiter.limit("120 per hour")
def user_correction_requests():
    claims = getattr(g, "user_claims", {}) or {}
    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    employee_oid = employee.get("_id")
    rows = list(
        db.manual_requests.find(
            {
                "employee_id": employee_oid,
                "$or": [
                    {"source": "correction"},
                    {
                        "source": {"$exists": False},
                        "request_type": {"$in": ["outside_office", "other", "wfh"]},
                    },
                ],
            }
        ).sort("created_at", -1)
    )
    return jsonify([_serialize_manual_request(row) for row in rows])


@app.get("/user/assets")
@user_auth_required
@limiter.limit("120 per hour")
def user_assets():
    claims = getattr(g, "user_claims", {}) or {}
    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    employee_oid = employee.get("_id")
    rows = list(db.assets.find({"employee_id": employee_oid}).sort("created_at", -1).limit(250))
    serialized = []
    for row in rows:
        item = _serialize_asset_doc(row)
        file_name = str(item.get("file_name") or "")
        asset_name = str(row.get("asset_name") or Path(file_name).stem.replace("_", " ").strip()).strip()
        category = str(row.get("asset_category") or item.get("file_type") or "other").strip()
        current_status = str(row.get("current_status") or "active").strip().lower() or "active"
        timeline = row.get("timeline") if isinstance(row.get("timeline"), list) else []
        assigned_date = str(row.get("assigned_date") or item.get("created_at") or "")[:10]
        if assigned_date and not timeline:
            timeline = [{"title": "Assigned", "at": assigned_date}]
        preview_url = str(item.get("file_url") or "").strip()
        if str(item.get("storage_provider") or "local").strip().lower() == "local":
            preview_url = f"/user/assets/files/{item.get('id')}"

        serialized.append(
            {
                **item,
                "asset_name": asset_name or "Assigned Asset",
                "asset_id": str(row.get("asset_id") or item.get("id") or ""),
                "asset_category": category,
                "brand_model": str(row.get("brand_model") or "-").strip() or "-",
                "assigned_date": assigned_date,
                "return_due_date": str(row.get("return_due_date") or "-").strip() or "-",
                "asset_condition": str(row.get("asset_condition") or "Good").strip() or "Good",
                "warranty_status": str(row.get("warranty_status") or "Unknown").strip() or "Unknown",
                "assigned_by": str(row.get("assigned_by") or item.get("uploaded_by") or "Admin").strip() or "Admin",
                "current_status": current_status,
                "timeline": timeline,
                "preview_url": preview_url,
            }
        )

    return jsonify(serialized)


@app.get("/user/assets/files/<asset_id>")
@limiter.limit("240 per hour")
def user_asset_file(asset_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    token = _extract_bearer_token_from_request() or str(request.args.get("token") or "").strip()
    if not token:
        return jsonify({"message": "Missing bearer token"}), 401

    try:
        claims = decode_user_token(token)
        if str(claims.get("role") or "") != "user":
            return jsonify({"message": "Invalid token"}), 401
    except Exception:
        return jsonify({"message": "Invalid token"}), 401

    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    try:
        oid = ObjectId(asset_id)
    except InvalidId:
        return jsonify({"message": "Invalid asset id"}), 400

    row = db.assets.find_one({"_id": oid, "employee_id": employee.get("_id")})
    if not row:
        return jsonify({"message": "Asset not found"}), 404

    file_url = str(row.get("file_url") or "").strip()
    storage_provider = str(row.get("storage_provider") or "local").strip().lower()

    if storage_provider == "cloudinary":
        if not file_url:
            return jsonify({"message": "File not found"}), 404
        return redirect(file_url)

    if not file_url or not file_url.startswith("/api/assets/files/"):
        return jsonify({"message": "File not found"}), 404

    rel_path = file_url.replace("/api/assets/files/", "", 1).lstrip("/")
    candidate = (ASSETS_DIR.resolve() / rel_path).resolve()
    if str(candidate).startswith(str(ASSETS_DIR.resolve())) is False:
        return jsonify({"message": "Invalid file path"}), 400
    if not candidate.exists() or not candidate.is_file():
        return jsonify({"message": "File not found"}), 404

    as_download = str(request.args.get("download") or "").strip().lower() in {"1", "true", "yes", "on"}
    return send_file(str(candidate), as_attachment=as_download)


@app.get("/user/asset_requests")
@user_auth_required
@limiter.limit("120 per hour")
def user_asset_requests():
    claims = getattr(g, "user_claims", {}) or {}
    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    employee_oid = employee.get("_id")
    rows = list(
        db.manual_requests.find(
            {
                "employee_id": employee_oid,
                "source": {"$in": ["asset_request", "asset_damage", "asset_return"]},
            }
        ).sort("created_at", -1)
    )
    return jsonify([_serialize_manual_request(row) for row in rows])


@app.post("/user/asset_requests")
@user_auth_required
@limiter.limit("60 per hour")
def user_create_asset_request():
    payload = request.form if request.form else (request.get_json(silent=True) or {})
    claims = getattr(g, "user_claims", {}) or {}
    if claims.get("must_change_password"):
        return jsonify({"message": "Please change password before submitting request"}), 403

    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    employee_oid = employee.get("_id")
    if employee_oid is None:
        return jsonify({"message": "Employee record missing id"}), 500

    request_type = str(payload.get("request_type") or "new_asset").strip().lower()
    category = str(payload.get("asset_category") or "other").strip()
    asset_name = str(payload.get("asset_name") or "").strip()
    priority = str(payload.get("priority") or "medium").strip().lower()
    reason = str(payload.get("reason") or "").strip()
    urgency_note = str(payload.get("urgency_note") or "").strip()
    linked_asset_id = str(payload.get("asset_id") or payload.get("linked_asset_id") or "").strip()
    request_source = str(payload.get("source") or "asset_request").strip().lower() or "asset_request"
    workflow_action = str(payload.get("workflow_action") or "").strip().lower()

    allowed_types = {
        "new_asset",
        "replacement",
        "repair_request",
        "return_request",
        "damage_report",
        "upgrade_request",
    }
    if request_type not in allowed_types:
        return jsonify({"message": "Invalid request type"}), 400

    if priority not in {"low", "medium", "high", "critical"}:
        return jsonify({"message": "Invalid priority level"}), 400

    if not category:
        return jsonify({"message": "Asset category is required"}), 400

    if not reason:
        return jsonify({"message": "Reason is required"}), 400

    attachment_path = ""
    attachment_file = request.files.get("attachment") or request.files.get("image")
    if attachment_file and attachment_file.filename:
        safe_name = _safe_asset_filename(attachment_file.filename)
        if not safe_name:
            safe_name = f"asset_request_{uuid.uuid4().hex}.bin"
        target = MANUAL_REQUESTS_IMAGE_DIR / f"asset_request_{uuid.uuid4().hex}_{safe_name}"
        attachment_file.save(str(target))
        attachment_path = str(target)

    now = ist_now()
    date_str = now.strftime("%Y-%m-%d")
    doc = {
        "employee_id": employee_oid,
        "employee_name": employee_name,
        "date": date_str,
        "request_type": "other",
        "work_mode": "office",
        "issue_type": "asset_request",
        "source": request_source,
        "reason": reason,
        "status": "pending",
        "asset_request_type": request_type,
        "asset_category": category,
        "asset_name": asset_name,
        "priority": priority,
        "urgency_note": urgency_note,
        "linked_asset_id": linked_asset_id,
        "workflow_action": workflow_action,
        "review_comment": "",
        "admin_remarks": "",
        "approved_by": "",
        "expected_resolution_date": "",
        "attachment_path": attachment_path,
        "created_at": now,
        "updated_at": now,
    }

    result = db.manual_requests.insert_one(doc)
    persist_mock_db_now()
    created = db.manual_requests.find_one({"_id": result.inserted_id})
    create_notification(
        f"{employee_name} submitted an asset request ({request_type})",
        "request",
    )
    return jsonify({"message": "Asset request submitted", "request": _serialize_manual_request(created)}), 201


@app.get("/user/helpdesk/tickets")
@user_auth_required
@limiter.limit("120 per hour")
def user_helpdesk_tickets():
    claims = getattr(g, "user_claims", {}) or {}
    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    employee_oid = employee.get("_id")
    rows = list(db.support_tickets.find({"employee_id": employee_oid}).sort("created_at", -1).limit(300))
    return jsonify([_serialize_support_ticket(row) for row in rows])


@app.post("/user/helpdesk/tickets")
@user_auth_required
@limiter.limit("60 per hour")
def user_create_helpdesk_ticket():
    payload = request.form if request.form else (request.get_json(silent=True) or {})
    claims = getattr(g, "user_claims", {}) or {}

    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    employee_oid = employee.get("_id")
    if employee_oid is None:
        return jsonify({"message": "Employee record missing id"}), 500

    category = str(payload.get("category") or "").strip().lower()
    subject = str(payload.get("subject") or "").strip()
    priority = str(payload.get("priority") or "medium").strip().lower()
    description = str(payload.get("description") or "").strip()
    preferred_contact_method = str(payload.get("preferred_contact_method") or "email").strip().lower()

    if category not in SUPPORT_TICKET_CATEGORIES:
        return jsonify({"message": "Invalid ticket category"}), 400
    if not subject:
        return jsonify({"message": "Subject is required"}), 400
    if priority not in SUPPORT_TICKET_PRIORITIES:
        return jsonify({"message": "Invalid priority"}), 400
    if not description:
        return jsonify({"message": "Description is required"}), 400
    if preferred_contact_method not in SUPPORT_TICKET_CONTACT_METHODS:
        return jsonify({"message": "Invalid preferred contact method"}), 400

    attachment_path = ""
    attachment_file = request.files.get("attachment")
    if attachment_file and attachment_file.filename:
        safe_name = _safe_asset_filename(attachment_file.filename)
        if not safe_name:
            safe_name = f"ticket_{uuid.uuid4().hex}.bin"
        target = MANUAL_REQUESTS_IMAGE_DIR / f"ticket_{uuid.uuid4().hex}_{safe_name}"
        attachment_file.save(str(target))
        attachment_path = str(target)

    now = ist_now()
    ticket_id = f"TKT-{now.strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
    doc = {
        "ticket_id": ticket_id,
        "employee_id": employee_oid,
        "employee_name": employee_name,
        "category": category,
        "subject": subject,
        "priority": priority,
        "description": description,
        "preferred_contact_method": preferred_contact_method,
        "status": "open",
        "assigned_to": "",
        "assigned_team": "",
        "resolution_date": "",
        "admin_remarks": "",
        "attachment_path": attachment_path,
        "created_at": now,
        "updated_at": now,
    }

    inserted = db.support_tickets.insert_one(doc)
    persist_mock_db_now()
    created = db.support_tickets.find_one({"_id": inserted.inserted_id})

    create_notification(
        f"Helpdesk ticket {ticket_id} raised for {subject}",
        "request",
        str(employee_oid),
        title="Ticket Submitted",
        priority=priority,
        category="helpdesk",
    )
    create_notification(
        f"{employee_name} raised helpdesk ticket {ticket_id} ({category.replace('_', ' ')})",
        "request",
        "",
        title="New Helpdesk Ticket",
        priority=priority,
        category="helpdesk",
    )

    return jsonify({"message": "Helpdesk ticket submitted", "ticket": _serialize_support_ticket(created)}), 201


@app.get("/user/payroll/payslips")
@user_auth_required
@limiter.limit("120 per hour")
def user_payroll_payslips():
    claims = getattr(g, "user_claims", {}) or {}
    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    employee_oid = employee.get("_id")
    employee_id = str(employee_oid or "")
    if not employee_id:
        return jsonify([])

    year = request.args.get("year", type=int)
    query = {"employee_id": employee_id}
    if year:
        query["year"] = int(year)

    rows = list(db.payslips.find(query).sort([("year", -1), ("month", -1)]).limit(120))

    def _serialize_payslip(item: dict) -> dict:
        row = dict(item or {})
        row["id"] = str(row.pop("_id", ""))
        for key in ("generated_at", "paid_at", "updated_at"):
            val = row.get(key)
            if isinstance(val, datetime):
                row[key] = val.isoformat()
        row["employee_id"] = str(row.get("employee_id") or employee_id)
        row["employee_name"] = str(row.get("employee_name") or employee.get("name") or "")
        row["department"] = str(row.get("department") or employee.get("department") or "General")
        row["status"] = str(row.get("status") or "processing").strip().lower()
        row["payslip_kind"] = str(row.get("payslip_kind") or "").strip().lower()
        return row

    return jsonify([_serialize_payslip(row) for row in rows])


@app.get("/user/payroll/summary")
@user_auth_required
@limiter.limit("120 per hour")
def user_payroll_summary():
    claims = getattr(g, "user_claims", {}) or {}
    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    employee_oid = employee.get("_id")
    employee_id = str(employee_oid or "")
    latest = db.payslips.find_one({"employee_id": employee_id}, sort=[("year", -1), ("month", -1)])

    pending_reimbursements = list(db.manual_requests.find({
        "employee_id": employee_oid,
        "source": {"$in": ["reimbursement", "payroll_reimbursement"]},
        "status": {"$in": ["pending", "approved"]},
    }))
    pending_reimbursement_amount = sum(float(row.get("amount") or 0) for row in pending_reimbursements)

    current_month_salary = 0.0
    net_pay = 0.0
    bonus = 0.0
    tax_deduction = 0.0
    if latest:
        current_month_salary = float(latest.get("gross_salary") or 0)
        net_pay = float(latest.get("net_salary") or 0)
        deductions = latest.get("deductions") or []
        for item in (deductions if isinstance(deductions, list) else []):
            code = str(item.get("code") or "").strip().upper()
            amount = float(item.get("amount") or 0)
            if code == "TDS":
                tax_deduction += amount
        earnings = latest.get("earnings") or []
        for item in (earnings if isinstance(earnings, list) else []):
            code = str(item.get("code") or "").strip().upper()
            amount = float(item.get("amount") or 0)
            if code in {"BONUS", "INCENTIVE", "INC"}:
                bonus += amount

    return jsonify({
        "current_month_salary": round(current_month_salary, 2),
        "net_pay": round(net_pay, 2),
        "pending_reimbursement": round(pending_reimbursement_amount, 2),
        "bonus_incentives": round(bonus, 2),
        "tax_deduction": round(tax_deduction, 2),
    })


# ─── User: salary accrual helpers ────────────────────────────────────────────

def _resolve_user_employee():
    """Return (employee_doc, employee_id_str) from the current user JWT, or (None, None)."""
    claims = getattr(g, "user_claims", {}) or {}
    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return None, None
    emp = db.employees.find_one({"name": employee_name})
    if not emp:
        return None, None
    return emp, str(emp.get("_id") or "")


@app.get("/user/payroll/accrual")
@user_auth_required
@limiter.limit("120 per hour")
def user_payroll_accrual():
    """
    Real-time salary accrual for the logged-in employee.
    Returns: monthlySalary, earnedTillNow, remainingSalary, todayEarnings,
             workingDaysInMonth, presentDays, attendancePct, dailyRate,
             payrollStatus, saturdayPolicy, statusBreakdown, projectedNetSalary
    Query: year, month (defaults to current calendar month in IST).
    """
    emp, employee_id = _resolve_user_employee()
    if not emp:
        return jsonify({"message": "Employee not found"}), 404

    today = _today_ist_date()
    try:
        year = int(request.args.get("year") or today.year)
        month = int(request.args.get("month") or today.month)
    except (TypeError, ValueError):
        year, month = today.year, today.month

    if month < 1 or month > 12:
        return jsonify({"message": "Invalid month"}), 400

    monthly_salary = float(emp.get("monthly_salary") or 0)

    if year == today.year and month == today.month:
        up_to_day = today.day
    elif year < today.year or (year == today.year and month < today.month):
        up_to_day = None
    else:
        up_to_day = None

    if not _payroll_ok():
        return jsonify({
            "employeeId": employee_id,
            "year": year,
            "month": month,
            "monthlySalary": monthly_salary,
            "earnedTillNow": 0.0,
            "remainingSalary": monthly_salary,
            "todayEarnings": 0.0,
            "workingDaysInMonth": 0,
            "presentDays": 0,
            "attendancePct": 0.0,
            "dailyRate": 0.0,
            "payrollStatus": "draft",
            "statusBreakdown": {},
            "projectedNetSalary": None,
            "saturdayPolicy": (emp.get("work_policy") or {}).get("saturdayPolicy", "OFF"),
        })

    summary = _payroll_calculator.get_month_summary(emp, year, month, up_to_day=up_to_day)
    earned = float(summary.get("earnedTillNow") or 0)
    remaining = max(0.0, round(monthly_salary - earned, 2))
    import calendar as _acal

    _, _ac = _acal.monthrange(year, month)
    cal_days = max(int(_ac), int(summary.get("calendarDaysInFullMonth") or 0))
    cal_days = max(1, cal_days)
    daily_rate = monthly_salary / cal_days if monthly_salary > 0 else 0.0

    # Today's earnings only when viewing the current month
    today_earnings = 0.0
    if year == today.year and month == today.month:
        today_entries = [e for e in summary.get("dailyEntries", []) if e.get("date") == today.isoformat()]
        today_earnings = today_entries[0]["finalAmount"] if today_entries else 0.0

    locked = db.payroll_summary.find_one({"employeeId": employee_id, "year": year, "month": month})
    payroll_status = locked.get("payrollStatus", "draft") if locked else "draft"

    projected_net = None
    try:
        structure = _get_salary_structure(employee_id)
        pv = _compute_payroll_preview(emp, structure, year, month)
        projected_net = round(float(pv.get("netSalary") or 0), 2)
    except Exception:
        projected_net = None

    return jsonify({
        "employeeId": employee_id,
        "year": year,
        "month": month,
        "monthlySalary": monthly_salary,
        "earnedTillNow": earned,
        "remainingSalary": remaining,
        "todayEarnings": round(today_earnings, 2),
        "workingDaysInMonth": summary.get("workingDaysInMonth", 0),
        "presentDays": summary.get("presentDays", 0),
        "attendancePct": summary.get("attendancePercentage", 0.0),
        "totalDeductions": summary.get("totalDeductions", 0.0),
        "totalOvertime": summary.get("totalOvertime", 0.0),
        "totalOvertimeHours": summary.get("totalOvertimeHours", 0.0),
        "dailyRate": round(daily_rate, 2),
        "payrollStatus": payroll_status,
        "statusBreakdown": summary.get("statusBreakdown", {}),
        "daysTracked": summary.get("daysTracked", 0),
        "saturdayPolicy": (emp.get("work_policy") or {}).get("saturdayPolicy", "OFF"),
        "projectedNetSalary": projected_net,
    })


@app.get("/user/payroll/ledger")
@user_auth_required
@limiter.limit("120 per hour")
def user_payroll_ledger():
    """Day-by-day salary ledger for the logged-in employee (current or specified month)."""
    emp, employee_id = _resolve_user_employee()
    if not emp:
        return jsonify({"message": "Employee not found"}), 404

    today = _today_ist_date()
    try:
        year  = int(request.args.get("year")  or today.year)
        month = int(request.args.get("month") or today.month)
    except (TypeError, ValueError):
        year, month = today.year, today.month

    up_to_day = today.day if (year == today.year and month == today.month) else None

    if not _payroll_ok():
        return jsonify({"entries": [], "year": year, "month": month})

    entries = _payroll_calculator.calculate_employee_month(emp, year, month, up_to_day)
    return jsonify({
        "employeeId": employee_id,
        "year": year,
        "month": month,
        "entries": entries,
    })


@app.get("/user/payroll/attendance-impact")
@user_auth_required
@limiter.limit("120 per hour")
def user_payroll_attendance_impact():
    """Attendance-impact breakdown: present, absent, halfDay, leaves, holidays, overtime."""
    emp, employee_id = _resolve_user_employee()
    if not emp:
        return jsonify({"message": "Employee not found"}), 404

    today = _today_ist_date()
    try:
        year  = int(request.args.get("year")  or today.year)
        month = int(request.args.get("month") or today.month)
    except (TypeError, ValueError):
        year, month = today.year, today.month

    up_to_day = today.day if (year == today.year and month == today.month) else None

    if not _payroll_ok():
        return jsonify({"impact": {}, "year": year, "month": month})

    summary = _payroll_calculator.get_month_summary(emp, year, month, up_to_day)
    bd = summary.get("statusBreakdown", {})
    monthly_salary = float(emp.get("monthly_salary") or emp.get("net_target_monthly") or 0)
    cal_days = max(1, int(summary.get("calendarDaysInFullMonth") or 0))
    daily_rate = monthly_salary / cal_days if monthly_salary > 0 else 0.0

    impact = {
        "present":     {"days": bd.get("present", 0) + bd.get("late", 0) + bd.get("early_out", 0),     "amount": round((bd.get("present", 0) + bd.get("late", 0) + bd.get("early_out", 0)) * daily_rate, 2)},
        "absent":      {"days": bd.get("absent", 0),      "amount": round(-bd.get("absent", 0) * daily_rate, 2)},
        "halfDay":     {"days": bd.get("half_day", 0),    "amount": round(bd.get("half_day", 0) * daily_rate * 0.5, 2)},
        "paidLeave":   {"days": bd.get("leave", 0),       "amount": round(bd.get("leave", 0) * daily_rate, 2)},
        "holiday":     {"days": bd.get("holiday", 0),     "amount": round(bd.get("holiday", 0) * daily_rate, 2)},
        "weekend":     {"days": bd.get("weekend", 0),     "amount": round(bd.get("weekend", 0) * daily_rate, 2)},
        "overtime":    {"hours": summary.get("totalOvertimeHours", 0), "amount": round(summary.get("totalOvertime", 0), 2)},
    }

    projected_net = None
    try:
        structure = _get_salary_structure(employee_id)
        pv = _compute_payroll_preview(emp, structure, year, month)
        projected_net = round(float(pv.get("netSalary") or 0), 2)
    except Exception:
        projected_net = None

    return jsonify({
        "employeeId": employee_id,
        "year": year,
        "month": month,
        "dailyRate": round(daily_rate, 2),
        "monthlySalary": monthly_salary,
        "impact": impact,
        "statusBreakdown": bd,
        "projectedNetSalary": projected_net,
    })


@app.get("/user/payroll/tax-documents")
@user_auth_required
@limiter.limit("120 per hour")
def user_payroll_tax_documents():
    """HR-uploaded document assets for this employee (Form 16 / PF / salary certificate heuristics)."""
    emp, _eid = _resolve_user_employee()
    if not emp or not emp.get("_id"):
        return jsonify({"message": "Employee not found"}), 404

    oid = emp["_id"]
    rows = list(
        db.assets.find({"employee_id": oid}).sort([("created_at", -1), ("_id", -1)]).limit(80),
    )

    def classify_fn(name: str) -> Optional[str]:
        fn = (name or "").lower().replace("_", " ")
        if re.search(r"form\s*16|form-16", fn):
            return "form16"
        if ("pf" in fn or "provident" in fn) and ("detail" in fn or "passbook" in fn or fn.endswith(".pdf")):
            return "pf"
        if "salary" in fn and "cert" in fn:
            return "salary_certificate"
        return None

    buckets = {"form16": None, "pf": None, "salary_certificate": None}
    other: List = []
    for row in rows:
        ser = _serialize_asset_doc(row)
        if ser.get("file_type") not in {"document", "raw"}:
            continue
        kind = classify_fn(ser.get("file_name") or "")
        if kind and buckets.get(kind) is None:
            buckets[kind] = ser
        else:
            other.append(ser)

    return jsonify({**buckets, "other_documents": other[:25]})


@app.get("/user/reimbursements")
@user_auth_required
@limiter.limit("120 per hour")
def user_reimbursements():
    claims = getattr(g, "user_claims", {}) or {}
    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    employee_oid = employee.get("_id")
    rows = list(
        db.manual_requests.find({
            "employee_id": employee_oid,
            "source": {"$in": ["reimbursement", "payroll_reimbursement"]},
        }).sort("created_at", -1)
    )
    return jsonify([_serialize_manual_request(row) for row in rows])


@app.post("/user/reimbursements")
@user_auth_required
@limiter.limit("60 per hour")
def user_create_reimbursement():
    payload = request.form if request.form else (request.get_json(silent=True) or {})
    claims = getattr(g, "user_claims", {}) or {}
    employee_name = slugify_name((claims.get("employee_name") or "").strip())
    if not employee_name:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"name": employee_name})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    expense_type = str(payload.get("expense_type") or "").strip().lower()
    amount_raw = payload.get("amount")
    expense_date = str(payload.get("expense_date") or payload.get("date") or ist_now().strftime("%Y-%m-%d")).strip()
    description = str(payload.get("description") or payload.get("reason") or "").strip()
    payment_method = str(payload.get("payment_method") or "").strip()
    emergency_comment = str(payload.get("emergency_comment") or "").strip()

    if expense_type not in {"travel", "food", "internet", "medical", "office_expense", "client_meeting"}:
        return jsonify({"message": "Invalid expense type"}), 400

    try:
        amount = float(amount_raw)
    except (TypeError, ValueError):
        return jsonify({"message": "Amount must be a valid number"}), 400
    if amount <= 0:
        return jsonify({"message": "Amount must be greater than 0"}), 400

    try:
        datetime.strptime(expense_date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"message": "Invalid expense date. Use YYYY-MM-DD"}), 400

    if not description:
        return jsonify({"message": "Description is required"}), 400

    attachment_path = ""
    bill_file = request.files.get("bill") or request.files.get("attachment")
    if bill_file and bill_file.filename:
        safe_name = _safe_asset_filename(bill_file.filename)
        if not safe_name:
            safe_name = f"reimbursement_{uuid.uuid4().hex}.bin"
        target = MANUAL_REQUESTS_IMAGE_DIR / f"reimbursement_{uuid.uuid4().hex}_{safe_name}"
        bill_file.save(str(target))
        attachment_path = str(target)

    employee_oid = employee.get("_id")
    now = ist_now()
    doc = {
        "employee_id": employee_oid,
        "employee_name": employee_name,
        "date": expense_date,
        "from_date": expense_date,
        "to_date": expense_date,
        "request_type": "other",
        "issue_type": "reimbursement",
        "expense_type": expense_type,
        "amount": round(float(amount), 2),
        "payment_method": payment_method,
        "reason": description,
        "description": description,
        "source": "reimbursement",
        "status": "pending",
        "emergency_comment": emergency_comment,
        "attachment_path": attachment_path,
        "created_at": now,
        "updated_at": now,
    }

    result = db.manual_requests.insert_one(doc)
    persist_mock_db_now()
    created = db.manual_requests.find_one({"_id": result.inserted_id})
    create_notification(
        f"{employee_name} submitted reimbursement request ({expense_type})",
        "request",
    )
    return jsonify({"message": "Reimbursement request submitted", "request": _serialize_manual_request(created)}), 201


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

    employee_oid = row.get("employee_id")
    admin_claims = getattr(g, "admin_claims", {}) or {}
    approver_name = str(admin_claims.get("sub") or admin_claims.get("username") or "admin").strip() or "admin"
    payload = request.get_json(silent=True) or {}
    review_comment = str(payload.get("comment") or payload.get("reason") or "Approved by admin").strip()
    employee = None
    if employee_oid is not None:
        employee = db.employees.find_one({"_id": employee_oid})
    if not employee:
        employee = db.employees.find_one({"name": row.get("employee_name", "")})
    if not employee:
        return jsonify({"message": "Employee not found for this request"}), 404

    employee_oid = employee.get("_id")
    employee_name = str(employee.get("name") or row.get("employee_name") or "").strip()
    request_type = str(row.get("request_type") or "").strip().lower()
    request_source = str(row.get("source") or "").strip().lower()
    reference_date = str(row.get("date") or "").strip()

    attendance_result = {"status": "not_applicable"}
    is_asset_request = request_source in {"asset_request", "asset_damage", "asset_return"}
    if request_source not in {"reimbursement", "payroll_reimbursement"} and not is_asset_request:
        if request_type == "leave":
            attendance_result = attendance_manager.mark_leave_for_employee(
                str(employee_oid),
                source="manual_request_approve",
                date=reference_date,
            )
        else:
            attendance_result = attendance_manager.mark_attendance(
                employee_name,
                source="manual",
                reference_at=row.get("created_at") or row.get("requested_at"),
            )
        if attendance_result.get("status") == "error":
            return jsonify({"message": attendance_result.get("message", "Unable to mark attendance")}), 400

        if attendance_result.get("status") == "already_recorded":
            now = ist_now()
            db.manual_requests.update_one(
                {"_id": oid},
                {
                    "$set": {
                        "status": "conflict",
                        "conflict_reason": "Attendance already marked for today",
                        "conflict_at": now,
                        "updated_at": now,
                        "employee_id": employee_oid,
                        "employee_name": employee_name,
                        "attendance_result": attendance_result,
                    }
                },
            )
            persist_mock_db_now()
            updated = db.manual_requests.find_one({"_id": oid})
            summary = _dashboard_summary_for_date(reference_date)
            return jsonify({
                "status": "attendance_exists",
                "message": "Attendance already marked for today. Manual request moved to conflict",
                "request": _serialize_manual_request(updated),
                "attendance": attendance_result,
                "dashboard": summary,
            }), 409

    now = ist_now()
    db.manual_requests.update_one(
        {"_id": oid},
        {
            "$set": {
                "status": "approved",
                "approved_at": now,
                "approved_by": approver_name,
                "review_comment": review_comment,
                "updated_at": now,
                "employee_id": employee_oid,
                "employee_name": employee_name,
                "attendance_result": attendance_result,
            }
        },
    )
    persist_mock_db_now()
    updated = db.manual_requests.find_one({"_id": oid})
    summary = _dashboard_summary_for_date(reference_date)
    create_notification(
        f"Your attendance correction request has been approved.",
        "request",
        str(employee_oid),
        title="Request Approved",
        priority="medium",
        category="attendance_correction_approved",
    )
    return jsonify({"message": "Manual request approved", "request": _serialize_manual_request(updated), "attendance": attendance_result, "dashboard": summary})


@app.post("/manual_requests/<request_id>/asset_status")
@admin_auth_required
@limiter.limit("240 per hour")
def update_asset_request_status(request_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(request_id)
    except InvalidId:
        return jsonify({"message": "Invalid request id"}), 400

    row = db.manual_requests.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Request not found"}), 404

    source = str(row.get("source") or "").strip().lower()
    if source not in {"asset_request", "asset_damage", "asset_return"}:
        return jsonify({"message": "Only asset requests can be updated here"}), 409

    payload = request.get_json(silent=True) or {}
    next_status = str(payload.get("status") or "").strip().lower()
    admin_remarks = str(payload.get("admin_remarks") or payload.get("remark") or payload.get("comment") or "").strip()
    approved_by = str(payload.get("approved_by") or payload.get("reviewed_by") or "").strip()
    expected_resolution_date = str(payload.get("expected_resolution_date") or payload.get("eta") or "").strip()
    workflow_action = str(payload.get("workflow_action") or "").strip().lower()

    allowed_status = {"pending", "approved", "rejected", "in_progress", "completed"}
    if next_status not in allowed_status:
        return jsonify({"message": "Invalid status"}), 400

    if expected_resolution_date:
        try:
            datetime.strptime(expected_resolution_date, "%Y-%m-%d")
        except ValueError:
            return jsonify({"message": "Invalid expected resolution date. Use YYYY-MM-DD"}), 400

    admin_claims = getattr(g, "admin_claims", {}) or {}
    reviewer = str(
        approved_by
        or admin_claims.get("sub")
        or admin_claims.get("username")
        or "admin"
    ).strip() or "admin"

    now = ist_now()
    update_doc = {
        "status": next_status,
        "review_comment": admin_remarks,
        "admin_remarks": admin_remarks,
        "approved_by": reviewer,
        "workflow_action": workflow_action,
        "updated_at": now,
    }
    if expected_resolution_date:
        update_doc["expected_resolution_date"] = expected_resolution_date

    if next_status == "approved":
        update_doc["approved_at"] = now
    if next_status == "rejected":
        update_doc["rejected_at"] = now

    db.manual_requests.update_one({"_id": oid}, {"$set": update_doc})
    persist_mock_db_now()
    updated = db.manual_requests.find_one({"_id": oid})

    asset_req_type = str(row.get("asset_request_type") or "asset request").replace("_", " ")
    notif_title = f"Asset Request {next_status.replace('_', ' ').title()}"
    create_notification(
        f"Your {asset_req_type} has been {next_status.replace('_', ' ')}.",
        "request",
        str(row.get("employee_id") or ""),
        title=notif_title,
        priority="medium",
        category="asset_request_update",
    )

    return jsonify({"message": "Asset request updated", "request": _serialize_manual_request(updated)})


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
    admin_claims = getattr(g, "admin_claims", {}) or {}
    reviewer_name = str(admin_claims.get("sub") or admin_claims.get("username") or "admin").strip() or "admin"
    reason = (payload.get("reason") or "Rejected by admin").strip()
    now = ist_now()
    db.manual_requests.update_one(
        {"_id": oid},
        {
            "$set": {
                "status": "rejected",
                "rejection_reason": reason,
                "review_comment": reason,
                "rejected_by": reviewer_name,
                "rejected_at": now,
                "updated_at": now,
            }
        },
    )
    persist_mock_db_now()
    updated = db.manual_requests.find_one({"_id": oid})
    summary = _dashboard_summary_for_date(str(row.get("date") or ""))
    create_notification(
        f"Your request has been rejected. Reason: {reason}",
        "request",
        str(row.get("employee_id") or ""),
        title="Request Rejected",
        priority="medium",
        category="attendance_correction_approved",
    )
    return jsonify({"message": "Manual request rejected", "request": _serialize_manual_request(updated), "dashboard": summary})


@app.post("/manual_requests/<request_id>/mark_paid")
@admin_auth_required
@limiter.limit("120 per hour")
def mark_manual_request_paid(request_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(request_id)
    except InvalidId:
        return jsonify({"message": "Invalid request id"}), 400

    row = db.manual_requests.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Request not found"}), 404

    source = str(row.get("source") or "").strip().lower()
    if source not in {"reimbursement", "payroll_reimbursement"}:
        return jsonify({"message": "Only reimbursement requests can be marked paid"}), 409

    if str(row.get("status") or "").strip().lower() not in {"approved", "paid"}:
        return jsonify({"message": "Only approved reimbursement can be marked paid"}), 409

    payload = request.get_json(silent=True) or {}
    admin_claims = getattr(g, "admin_claims", {}) or {}
    approver_name = str(admin_claims.get("sub") or admin_claims.get("username") or "admin").strip() or "admin"
    payment_date = str(payload.get("payment_date") or ist_now().strftime("%Y-%m-%d")).strip()
    remark = str(payload.get("remark") or payload.get("comment") or "Payment released").strip()

    try:
        datetime.strptime(payment_date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"message": "Invalid payment date. Use YYYY-MM-DD"}), 400

    now = ist_now()
    db.manual_requests.update_one(
        {"_id": oid},
        {
            "$set": {
                "status": "paid",
                "paid_at": now,
                "payment_date": payment_date,
                "paid_by": approver_name,
                "review_comment": remark,
                "updated_at": now,
            }
        },
    )
    persist_mock_db_now()
    updated = db.manual_requests.find_one({"_id": oid})
    create_notification(
        f"Your reimbursement payment has been released. Payment date: {payment_date}.",
        "request",
        str(row.get("employee_id") or ""),
        title="Reimbursement Paid",
        priority="medium",
        category="reimbursement_approved",
    )
    return jsonify({"message": "Reimbursement marked as paid", "request": _serialize_manual_request(updated)})


def _iter_date_range(start_date_text: str, end_date_text: str):
    start_date = datetime.strptime(start_date_text, "%Y-%m-%d").date()
    end_date = datetime.strptime(end_date_text, "%Y-%m-%d").date()
    cursor = start_date
    while cursor <= end_date:
        yield cursor.strftime("%Y-%m-%d")
        cursor += timedelta(days=1)


@app.post("/api/leave_requests")
@user_auth_required
@limiter.limit("60 per hour")
def create_leave_request():
    claims = getattr(g, "user_claims", {}) or {}
    employee_id = str(claims.get("employee_id") or "").strip()
    if not employee_id:
        return jsonify({"message": "Invalid user token"}), 401

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        employee_oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"_id": employee_oid})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    payload = request.get_json(silent=True) or {}
    start_date = str(payload.get("start_date") or "").strip()
    end_date = str(payload.get("end_date") or start_date).strip()
    reason = str(payload.get("reason") or "").strip()
    leave_type = str(payload.get("leave_type") or "casual").strip().lower()

    if not start_date:
        return jsonify({"message": "start_date is required"}), 400
    if not reason:
        return jsonify({"message": "Reason is required"}), 400

    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"message": "Invalid date format. Use YYYY-MM-DD."}), 400

    if end_dt < start_dt:
        return jsonify({"message": "end_date cannot be before start_date"}), 400
    if (end_dt - start_dt).days > 60:
        return jsonify({"message": "Leave request range cannot exceed 60 days"}), 400

    overlap = db.leave_requests.find_one(
        {
            "employee_id": employee_oid,
            "status": {"$in": ["pending", "approved"]},
            "$or": [
                {"start_date": {"$lte": end_date}, "end_date": {"$gte": start_date}},
            ],
        }
    )
    if overlap:
        return jsonify({"message": "Overlapping leave request already exists"}), 409

    now = ist_now()
    doc = {
        "employee_id": employee_oid,
        "employee_name": str(employee.get("name") or ""),
        "start_date": start_date,
        "end_date": end_date,
        "reason": reason,
        "leave_type": leave_type,
        "status": "pending",
        "created_at": now,
        "updated_at": now,
    }
    inserted = db.leave_requests.insert_one(doc)
    persist_mock_db_now()
    created = db.leave_requests.find_one({"_id": inserted.inserted_id})
    summary = _dashboard_summary_for_date(start_date)
    create_notification(
        f"Your leave request from {start_date} to {end_date} has been submitted and is pending approval.",
        "leave",
        str(employee_oid),
        title="Leave Request Submitted",
        priority="medium",
        category="leave_approved_rejected",
    )
    return jsonify({"message": "Leave request submitted", "request": _serialize_leave_request(created), "dashboard": summary}), 201


@app.get("/api/leave_requests")
@admin_auth_required
def list_leave_requests():
    status = str(request.args.get("status") or "").strip().lower()
    employee_id = str(request.args.get("employee_id") or "").strip()
    company_id = str(request.args.get("company_id") or "").strip()

    query = {}
    if status:
        query["status"] = status

    if employee_id:
        from bson import ObjectId
        from bson.errors import InvalidId
        id_literals = {str(employee_id)}
        try:
            if len(str(employee_id)) == 24:
                id_literals.add(ObjectId(employee_id))
        except InvalidId:
            pass
        query["employee_id"] = {"$in": list(id_literals)}

    if company_id and not employee_id:
        company_employee_ids = _get_company_employee_ids(company_id)
        id_literals = []
        for eid in company_employee_ids:
            id_literals.append(eid)
            id_literals.append(str(eid))
        query["employee_id"] = {"$in": id_literals}

    rows = []
    if hasattr(db, "leave_requests_v2"):
        rows.extend(list(db.leave_requests_v2.find(query).sort("applied_at", -1)))
    if hasattr(db, "leave_requests"):
        rows.extend(list(db.leave_requests.find(query).sort("applied_at", -1)))

    seen = set()
    merged = []
    for row in rows:
        rid = str(row.get("_id") or "")
        if not rid or rid in seen:
            continue
        seen.add(rid)
        merged.append(row)

    def _sort_key(row):
        return str(row.get("applied_at") or row.get("created_at") or row.get("start_date") or "")

    merged.sort(key=_sort_key, reverse=True)
    return jsonify([_serialize_leave_request(row) for row in merged])


@app.post("/api/leave_requests/<request_id>/approve")
@admin_auth_required
@limiter.limit("120 per hour")
def approve_leave_request(request_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(request_id)
    except InvalidId:
        return jsonify({"message": "Invalid request id"}), 400

    row = db.leave_requests.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Request not found"}), 404
    if row.get("status") != "pending":
        return jsonify({"message": "Only pending requests can be approved"}), 409

    employee_oid = row.get("employee_id")
    if employee_oid is None:
        return jsonify({"message": "Request missing employee reference"}), 409

    dates = list(_iter_date_range(str(row.get("start_date") or ""), str(row.get("end_date") or "")))
    applied = []
    for day in dates:
        result = attendance_manager.mark_leave_for_employee(str(employee_oid), source="leave_request_approve", date=day)
        if result.get("status") == "error":
            return jsonify({"message": result.get("message", "Unable to apply leave"), "date": day}), 400
        applied.append({"date": day, "result": result.get("status")})

    now = ist_now()
    db.leave_requests.update_one(
        {"_id": oid},
        {
            "$set": {
                "status": "approved",
                "approved_at": now,
                "updated_at": now,
                "applied_dates": dates,
            }
        },
    )
    persist_mock_db_now()
    updated = db.leave_requests.find_one({"_id": oid})
    summary = _dashboard_summary_for_date(dates[0] if dates else None)
    create_notification(
        f"Your leave request from {row.get('start_date')} to {row.get('end_date')} has been approved. Enjoy your time off!",
        "request",
        str(employee_oid),
        title="Leave Approved",
        priority="medium",
        category="leave_approved_rejected",
    )
    return jsonify({"message": "Leave request approved", "request": _serialize_leave_request(updated), "applied": applied, "dashboard": summary})


@app.post("/api/leave_requests/<request_id>/reject")
@admin_auth_required
@limiter.limit("120 per hour")
def reject_leave_request(request_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(request_id)
    except InvalidId:
        return jsonify({"message": "Invalid request id"}), 400

    row = db.leave_requests.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Request not found"}), 404
    if row.get("status") != "pending":
        return jsonify({"message": "Only pending requests can be rejected"}), 409

    payload = request.get_json(silent=True) or {}
    reason = str(payload.get("reason") or "Rejected by admin").strip()
    now = ist_now()
    db.leave_requests.update_one(
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
    updated = db.leave_requests.find_one({"_id": oid})
    summary = _dashboard_summary_for_date(str(row.get("start_date") or ""))
    create_notification(
        f"Your leave request from {row.get('start_date')} to {row.get('end_date')} has been rejected. Reason: {reason}",
        "request",
        str(row.get("employee_id") or ""),
        title="Leave Rejected",
        priority="medium",
        category="leave_approved_rejected",
    )
    return jsonify({"message": "Leave request rejected", "request": _serialize_leave_request(updated), "dashboard": summary})


@app.post("/tasks")
@admin_auth_required
@limiter.limit("240 per hour")
def create_task():
    payload = request.get_json(silent=True) or {}

    title = str(payload.get("title") or "").strip()
    description = str(payload.get("description") or "").strip()
    assigned_to = str(payload.get("assigned_to") or "").strip()
    assigned_by = str(payload.get("assigned_by") or getattr(g, "admin_claims", {}).get("sub") or "admin").strip()
    priority = _normalize_task_priority(payload.get("priority"))
    status = _normalize_task_status(payload.get("status"))
    checklist_items = payload.get("checklist_items") or []
    if not isinstance(checklist_items, list):
        checklist_items = []
    normalized_checklist = []
    for item in checklist_items:
        if isinstance(item, dict):
            title_text = str(item.get("title") or "").strip()
            done_flag = bool(item.get("done"))
        else:
            title_text = str(item or "").strip()
            done_flag = False
        if title_text:
            normalized_checklist.append({"title": title_text, "done": done_flag})

    tags = payload.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    tags = [str(t).strip() for t in tags if str(t).strip()]

    attachments = payload.get("attachments") or []
    if not isinstance(attachments, list):
        attachments = []

    department_tag = str(payload.get("department_tag") or "").strip() or "General"
    shift_tag = str(payload.get("shift_tag") or "").strip().lower() or "day"
    due_time = str(payload.get("due_time") or "").strip()
    start_date_raw = str(payload.get("start_date") or "").strip()
    estimated_hours = payload.get("estimated_hours")
    recurring = bool(payload.get("recurring"))

    try:
        estimated_hours = float(estimated_hours) if estimated_hours not in (None, "") else None
    except (TypeError, ValueError):
        estimated_hours = None

    if not title:
        return jsonify({"message": "Task title is required"}), 400
    if not description:
        return jsonify({"message": "Task description is required"}), 400
    if not assigned_to:
        return jsonify({"message": "assigned_to is required"}), 400
    if not due_time:
        return jsonify({"message": "Task due time is required"}), 400

    try:
        deadline = _parse_task_deadline(payload.get("deadline"))
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    try:
        start_date = _parse_task_start_date(start_date_raw)
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    if start_date and start_date.date() > deadline.date():
        return jsonify({"message": "Start date cannot be after deadline"}), 400

    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        assignee_oid = ObjectId(assigned_to)
    except InvalidId:
        return jsonify({"message": "Invalid assigned_to employee id"}), 400

    employee = db.employees.find_one({"_id": assignee_oid})
    if not employee:
        return jsonify({"message": "Assigned employee not found"}), 404

    now = datetime.now()
    doc = {
        "title": title,
        "description": description,
        "assigned_to": assigned_to,
        "assigned_to_name": employee.get("name", ""),
        "assigned_to_department": employee.get("department", "General"),
        "assigned_by": assigned_by,
        "start_date": start_date,
        "deadline": deadline,
        "priority": priority,
        "status": status,
        "due_time": due_time,
        "department_tag": department_tag,
        "shift_tag": shift_tag,
        "estimated_hours": estimated_hours,
        "recurring": recurring,
        "checklist_items": normalized_checklist,
        "tags": tags,
        "attachments": attachments,
        "comments": [],
        "activity": [
            {
                "type": "created",
                "by": assigned_by,
                "at": now,
                "text": "Task created",
            }
        ],
        "comment": "",
        "created_at": now,
        "updated_at": now,
        "completed_at": now if status == "completed" else None,
    }
    created = db.tasks.insert_one(doc)
    persist_mock_db_now()
    saved = db.tasks.find_one({"_id": created.inserted_id})
    log_audit("task_created", target={"assigned_to": assigned_to, "title": title})
    return jsonify({"message": "Task assigned", "task": _serialize_task(saved)}), 201


@app.post("/user/tasks")
@user_auth_required
@limiter.limit("120 per hour")
def create_user_task():
    payload = request.get_json(silent=True) or {}
    claims = getattr(g, "user_claims", {}) or {}

    employee_id = str(claims.get("employee_id") or "").strip()
    employee_name = str(claims.get("employee_name") or "").strip()
    login_id = str(claims.get("login_id") or "").strip()
    if not employee_id:
        return jsonify({"message": "Invalid user token"}), 401

    title = str(payload.get("title") or "").strip()
    description = str(payload.get("description") or "").strip()
    priority = _normalize_task_priority(payload.get("priority"))
    status = _normalize_task_status(payload.get("status") or "not_started")
    checklist_items = payload.get("checklist_items") or []
    if not isinstance(checklist_items, list):
        checklist_items = []
    normalized_checklist = []
    for item in checklist_items:
        if isinstance(item, dict):
            title_text = str(item.get("title") or "").strip()
            done_flag = bool(item.get("done"))
        else:
            title_text = str(item or "").strip()
            done_flag = False
        if title_text:
            normalized_checklist.append({"title": title_text, "done": done_flag})

    if not title:
        return jsonify({"message": "Task title is required"}), 400
    if not description:
        return jsonify({"message": "Task description is required"}), 400
    if not str(payload.get("due_time") or "").strip():
        return jsonify({"message": "Task due time is required"}), 400

    try:
        deadline = _parse_task_deadline(payload.get("deadline"))
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    employee = db.employees.find_one({"login_id": login_id}) if login_id else None
    department = (employee or {}).get("department", "General")

    now = datetime.now()
    doc = {
        "title": title,
        "description": description,
        "assigned_to": employee_id,
        "assigned_to_name": employee_name,
        "assigned_to_department": department,
        "assigned_by": employee_name or login_id or "employee",
        "deadline": deadline,
        "priority": priority,
        "status": status,
        "due_time": str(payload.get("due_time") or "").strip(),
        "department_tag": str(payload.get("department_tag") or department or "General").strip() or "General",
        "shift_tag": str(payload.get("shift_tag") or "day").strip().lower() or "day",
        "estimated_hours": None,
        "recurring": bool(payload.get("recurring")),
        "checklist_items": normalized_checklist,
        "tags": ["employee-created"],
        "attachments": [],
        "comments": [],
        "activity": [
            {
                "type": "created",
                "by": employee_name or login_id or "employee",
                "at": now,
                "text": f"Task created by employee (checklist: {len(normalized_checklist)})",
            }
        ],
        "comment": "",
        "created_at": now,
        "updated_at": now,
        "completed_at": now if status == "completed" else None,
    }
    created = db.tasks.insert_one(doc)
    persist_mock_db_now()
    saved = db.tasks.find_one({"_id": created.inserted_id})
    log_audit("task_created_by_employee", target={"assigned_to": employee_id, "title": title})
    return jsonify({"message": "Task created", "task": _serialize_task(saved)}), 201


def _task_query_from_param(task_id: str):
    token = str(task_id or "").strip()
    if not token:
        return None
    candidates = [{"_id": token}, {"id": token}]
    try:
        from bson import ObjectId
        candidates.insert(0, {"_id": ObjectId(token)})
    except Exception:
        pass
    return {"$or": candidates}


def _task_access_allowed_for_user(task: dict, claims: dict) -> bool:
    if not isinstance(task, dict):
        return False

    assigned_to = str(task.get("assigned_to") or "").strip()
    employee_id = str((claims or {}).get("employee_id") or "").strip()
    login_id = str((claims or {}).get("login_id") or "").strip().lower()
    employee_name = str((claims or {}).get("employee_name") or "").strip().lower()

    if employee_id and assigned_to == employee_id:
        return True
    if assigned_to and login_id and assigned_to.lower() == login_id:
        return True

    assigned_name = str(task.get("assigned_to_name") or "").strip().lower()
    if assigned_name and employee_name and assigned_name == employee_name:
        return True

    tags = [str(x or "").strip().lower() for x in (task.get("tags") or []) if str(x or "").strip()]
    assigned_by = str(task.get("assigned_by") or "").strip().lower()
    if "employee-created" in tags and ((login_id and assigned_by == login_id) or (employee_name and assigned_by == employee_name)):
        return True

    return False


@app.get("/tasks")
def list_tasks():
    auth = _decode_any_bearer_claims()
    if auth.get("error"):
        message, code = auth["error"]
        return jsonify({"message": message}), code

    query = {}
    if auth.get("role") == "admin":
        company_id = str(request.args.get("company_id") or "").strip()
        if company_id:
            company_employee_ids = _get_company_employee_ids(company_id)
            str_ids = [str(eid) for eid in company_employee_ids]
            query["assigned_to"] = {"$in": str_ids}
    elif auth.get("role") == "user":
        query = {"assigned_to": str((auth.get("claims") or {}).get("employee_id") or "")}
    else:
        return jsonify({"message": "Missing bearer token"}), 401

    rows = list(db.tasks.find(query).sort("deadline", 1))
    return jsonify([_serialize_task(row) for row in rows])


@app.get("/tasks/<employee_id>")
@admin_auth_required
def list_tasks_by_employee(employee_id):
    rows = list(db.tasks.find({"assigned_to": str(employee_id)}).sort("deadline", 1))
    return jsonify([_serialize_task(row) for row in rows])


@app.patch("/tasks/<task_id>/status")
@user_auth_required
@limiter.limit("240 per hour")
def update_task_status(task_id):
    payload = request.get_json(silent=True) or {}
    has_status = "status" in payload
    has_comment = "comment" in payload
    next_status = _normalize_task_status(payload.get("status")) if has_status else ""
    comment = str(payload.get("comment") or "").strip() if has_comment else ""
    checklist_index_raw = payload.get("checklist_index")
    checklist_done_raw = payload.get("checklist_done")

    task_query = _task_query_from_param(task_id)
    if not task_query:
        return jsonify({"message": "Invalid task id"}), 400

    claims = getattr(g, "user_claims", {}) or {}
    task = db.tasks.find_one(task_query)
    if not task:
        return jsonify({"message": "Task not found"}), 404

    if not _task_access_allowed_for_user(task, claims):
        return jsonify({"message": "Not allowed to update this task"}), 403
    if has_status and next_status == "approved":
        return jsonify({"message": "Only admin can approve tasks"}), 403

    now = datetime.now()
    final_status = _normalize_task_status(task.get("status"))
    if has_status:
        final_status = next_status
    final_comment = str(task.get("comment") or "")
    if has_comment:
        final_comment = comment

    update_doc = {
        "status": final_status,
        "comment": final_comment,
        "updated_at": now,
    }
    if has_status and final_status == "completed":
        update_doc["completed_at"] = now
        update_doc["approved_at"] = None
    elif has_status:
        update_doc["completed_at"] = None
        update_doc["approved_at"] = None
    else:
        update_doc["completed_at"] = task.get("completed_at")
        update_doc["approved_at"] = task.get("approved_at")

    checklist_item_title = ""
    if checklist_index_raw is not None:
        try:
            checklist_index = int(checklist_index_raw)
        except (TypeError, ValueError):
            return jsonify({"message": "checklist_index must be an integer"}), 400
        checklist_done = bool(checklist_done_raw)
        checklist = task.get("checklist_items") or []
        if not isinstance(checklist, list) or not checklist:
            return jsonify({"message": "Checklist not available for this task"}), 400
        if checklist_index < 0 or checklist_index >= len(checklist):
            return jsonify({"message": "Checklist index out of range"}), 400
        normalized_checklist = []
        for i, item in enumerate(checklist):
            if isinstance(item, dict):
                title_text = str(item.get("title") or "").strip()
                done_flag = bool(item.get("done"))
            else:
                title_text = str(item or "").strip()
                done_flag = False
            if i == checklist_index:
                done_flag = checklist_done
                checklist_item_title = title_text or f"Checklist {i + 1}"
            normalized_checklist.append({"title": title_text or f"Checklist {i + 1}", "done": done_flag})
        update_doc["checklist_items"] = normalized_checklist

    push_doc = {
        "activity": {
            "type": "status_changed",
            "by": str(claims.get("login_id") or claims.get("employee_name") or "user"),
            "at": now,
            "text": f"Status changed to {final_status}",
        }
    }
    if checklist_index_raw is not None:
        push_doc["activity"] = {
            "type": "checklist_updated",
            "by": str(claims.get("login_id") or claims.get("employee_name") or "user"),
            "at": now,
            "text": f"Checklist item '{checklist_item_title or 'item'}' marked {'done' if bool(checklist_done_raw) else 'pending'}",
        }
    if has_comment and final_comment:
        push_doc["comments"] = {
            "by": str(claims.get("login_id") or claims.get("employee_name") or "user"),
            "text": final_comment,
            "at": now,
        }

    db.tasks.update_one(
        {"_id": task.get("_id")},
        {
            "$set": update_doc,
            "$push": push_doc,
        },
    )
    persist_mock_db_now()
    saved = db.tasks.find_one({"_id": task.get("_id")})
    return jsonify({"message": "Task status updated", "task": _serialize_task(saved)})


@app.patch("/tasks/<task_id>/checklist")
@user_auth_required
@limiter.limit("480 per hour")
def update_task_checklist_item(task_id):
    payload = request.get_json(silent=True) or {}
    index = payload.get("index")
    done = bool(payload.get("done"))

    try:
        idx = int(index)
    except (TypeError, ValueError):
        return jsonify({"message": "index must be an integer"}), 400

    task_query = _task_query_from_param(task_id)
    if not task_query:
        return jsonify({"message": "Invalid task id"}), 400

    claims = getattr(g, "user_claims", {}) or {}
    actor = str(claims.get("login_id") or claims.get("employee_name") or "user")

    task = db.tasks.find_one(task_query)
    if not task:
        return jsonify({"message": "Task not found"}), 404
    if not _task_access_allowed_for_user(task, claims):
        return jsonify({"message": "Not allowed to update this task"}), 403

    checklist = task.get("checklist_items") or []
    if not isinstance(checklist, list) or not checklist:
        return jsonify({"message": "Checklist not available for this task"}), 400
    if idx < 0 or idx >= len(checklist):
        return jsonify({"message": "Checklist index out of range"}), 400

    normalized = []
    for i, item in enumerate(checklist):
        if isinstance(item, dict):
            title_text = str(item.get("title") or "").strip()
            done_flag = bool(item.get("done"))
        else:
            title_text = str(item or "").strip()
            done_flag = False
        if i == idx:
            done_flag = done
        normalized.append({"title": title_text or f"Checklist {i + 1}", "done": done_flag})

    now = datetime.now()
    item_title = normalized[idx].get("title") or f"Checklist {idx + 1}"

    db.tasks.update_one(
        {"_id": task.get("_id")},
        {
            "$set": {
                "checklist_items": normalized,
                "updated_at": now,
            },
            "$push": {
                "activity": {
                    "type": "checklist_updated",
                    "by": actor,
                    "at": now,
                    "text": f"Checklist item '{item_title}' marked {'done' if done else 'pending'}",
                }
            },
        },
    )
    persist_mock_db_now()
    saved = db.tasks.find_one({"_id": task.get("_id")})
    return jsonify({"message": "Checklist updated", "task": _serialize_task(saved)})


@app.post("/tasks/<task_id>/proof_metadata")
@user_auth_required
@limiter.limit("240 per hour")
def add_task_proof_metadata(task_id):
    payload = request.get_json(silent=True) or {}
    files = payload.get("files") or []
    if not isinstance(files, list) or not files:
        return jsonify({"message": "files array is required"}), 400

    task_query = _task_query_from_param(task_id)
    if not task_query:
        return jsonify({"message": "Invalid task id"}), 400

    claims = getattr(g, "user_claims", {}) or {}
    actor = str(claims.get("login_id") or claims.get("employee_name") or "user")

    task = db.tasks.find_one(task_query)
    if not task:
        return jsonify({"message": "Task not found"}), 404
    if not _task_access_allowed_for_user(task, claims):
        return jsonify({"message": "Not allowed to update this task"}), 403

    clean_files = []
    for f in files:
        if not isinstance(f, dict):
            continue
        name = str(f.get("name") or "").strip()
        if not name:
            continue
        clean_files.append(
            {
                "name": name,
                "size": int(f.get("size") or 0),
                "type": str(f.get("type") or ""),
                "uploaded_by": actor,
                "uploaded_at": datetime.now(),
            }
        )

    if not clean_files:
        return jsonify({"message": "No valid files provided"}), 400

    db.tasks.update_one(
        {"_id": task.get("_id")},
        {
            "$set": {"updated_at": datetime.now()},
            "$push": {
                "attachments": {"$each": clean_files},
                "activity": {
                    "type": "proof_uploaded",
                    "by": actor,
                    "at": datetime.now(),
                    "text": f"Uploaded {len(clean_files)} proof file(s)",
                },
            },
        },
    )
    persist_mock_db_now()
    saved = db.tasks.find_one({"_id": task.get("_id")})
    return jsonify({"message": "Proof uploaded", "task": _serialize_task(saved)})


@app.patch("/admin/tasks/<task_id>/status")
@admin_auth_required
@limiter.limit("240 per hour")
def admin_update_task_status(task_id):
    payload = request.get_json(silent=True) or {}
    next_status = _normalize_task_status(payload.get("status"))
    comment = str(payload.get("comment") or "").strip()

    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(task_id)
    except InvalidId:
        return jsonify({"message": "Invalid task id"}), 400

    task = db.tasks.find_one({"_id": oid})
    if not task:
        return jsonify({"message": "Task not found"}), 404

    now = datetime.now()
    update_doc = {
        "status": next_status,
        "comment": comment,
        "updated_at": now,
    }
    if next_status == "completed":
        update_doc["completed_at"] = now
        update_doc["approved_at"] = None
    elif next_status == "approved":
        update_doc["approved_at"] = now
        update_doc["completed_at"] = task.get("completed_at") or now
    else:
        update_doc["completed_at"] = None
        update_doc["approved_at"] = None

    db.tasks.update_one(
        {"_id": oid},
        {
            "$set": update_doc,
            "$push": {
                "activity": {
                    "type": "status_changed",
                    "by": str((getattr(g, "admin_claims", {}) or {}).get("sub") or "admin"),
                    "at": now,
                    "text": f"Status changed to {next_status}",
                }
            },
        },
    )
    persist_mock_db_now()
    saved = db.tasks.find_one({"_id": oid})
    return jsonify({"message": "Task status updated", "task": _serialize_task(saved)})


@app.post("/admin/tasks/<task_id>/reminder")
@admin_auth_required
@limiter.limit("240 per hour")
def admin_send_task_reminder(task_id):
    payload = request.get_json(silent=True) or {}
    custom_text = str(payload.get("message") or "").strip()

    task_query = _task_query_from_param(task_id)
    if not task_query:
        return jsonify({"message": "Invalid task id"}), 400

    task = db.tasks.find_one(task_query)
    if not task:
        return jsonify({"message": "Task not found"}), 404

    now = datetime.now()
    actor = str((getattr(g, "admin_claims", {}) or {}).get("sub") or "admin")
    task_title = str(task.get("title") or "Task").strip() or "Task"
    text = custom_text or f"Reminder sent for '{task_title}'"

    db.tasks.update_one(
        {"_id": task.get("_id")},
        {
            "$set": {
                "updated_at": now,
            },
            "$push": {
                "activity": {
                    "type": "reminder_sent",
                    "by": actor,
                    "at": now,
                    "text": text,
                }
            },
        },
    )
    persist_mock_db_now()
    saved = db.tasks.find_one({"_id": task.get("_id")})
    return jsonify({"message": "Reminder sent", "task": _serialize_task(saved)})


@app.delete("/tasks/<task_id>")
@admin_auth_required
@limiter.limit("240 per hour")
def delete_task(task_id):
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(task_id)
    except InvalidId:
        return jsonify({"message": "Invalid task id"}), 400

    task = db.tasks.find_one({"_id": oid})
    if not task:
        return jsonify({"message": "Task not found"}), 404

    db.tasks.delete_one({"_id": oid})
    persist_mock_db_now()
    log_audit("task_deleted", target={"task_id": task_id, "title": task.get("title")})
    return jsonify({"message": "Task deleted"})


@app.post("/stop_camera")
@admin_auth_required
@limiter.limit("20 per hour")
def stop_camera():
    result = face_recognizer.stop()
    return jsonify(result)


@app.get("/camera_status")
@admin_auth_required
def camera_status():
    try:
        if not face_recognizer:
            return jsonify({"running": False, "last_event": None, "disabled": True})
        return jsonify({"running": face_recognizer.is_running, "last_event": face_recognizer.last_event})
    except Exception as e:
        logger.error(f"camera_status error: {e}")
        return jsonify({"running": False, "last_event": None, "disabled": True, "error": str(e)}), 200


@app.get("/camera_events")
@admin_auth_required
def camera_events():
    try:
        if not face_recognizer:
            return jsonify([])
        return jsonify(face_recognizer.events)
    except Exception as e:
        logger.error(f"camera_events error: {e}")
        return jsonify([]), 200


@app.get("/recognition_settings")
@admin_auth_required
def recognition_settings():
    try:
        if not face_recognizer:
            return jsonify({"enabled": False})
        return jsonify(face_recognizer.get_settings())
    except Exception as e:
        logger.error(f"recognition_settings error: {e}")
        return jsonify({"enabled": False}), 200


@app.put("/recognition_settings")
@admin_auth_required
@limiter.limit("60 per hour")
def update_recognition_settings():
    payload = request.get_json(silent=True) or {}
    try:
        if not face_recognizer:
            return jsonify({"message": "Face recognition is disabled"}), 400
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
    date_raw = str(request.args.get("date", "")).strip()
    date_value = None

    logger.info(
        "attendance_fetch_requested",
        extra={
            "event": "attendance_fetch_requested",
            "request_id": getattr(g, "request_id", None),
            "method": request.method,
            "path": request.path,
            "app_env": APP_ENV,
        },
    )

    if date_raw:
        try:
            date_value = datetime.strptime(date_raw, "%Y-%m-%d").strftime("%Y-%m-%d")
        except ValueError:
            logger.warning(
                "attendance_invalid_date_format: %s",
                date_raw,
                extra={
                    "event": "attendance_invalid_date_format",
                    "request_id": getattr(g, "request_id", None),
                    "method": request.method,
                    "path": request.path,
                    "app_env": APP_ENV,
                },
            )
            return (
                jsonify(
                    {
                        "error": "invalid_date",
                        "message": "Invalid date format. Use YYYY-MM-DD.",
                        "details": {"date": date_raw},
                    }
                ),
                400,
            )

    try:
        rows = attendance_manager.list_attendance(date=date_value)
        if not isinstance(rows, list):
            rows = []
        return jsonify(rows)
    except PyMongoError as error:
        logger.exception(
            "attendance_query_failed",
            extra={
                "event": "attendance_query_failed",
                "request_id": getattr(g, "request_id", None),
                "method": request.method,
                "path": request.path,
                "app_env": APP_ENV,
            },
        )
        return (
            jsonify(
                {
                    "error": "database_error",
                    "message": "Failed to fetch attendance records.",
                    "details": str(error),
                }
            ),
            500,
        )
    except Exception as error:
        logger.exception(
            "attendance_fetch_failed",
            extra={
                "event": "attendance_fetch_failed",
                "request_id": getattr(g, "request_id", None),
                "method": request.method,
                "path": request.path,
                "app_env": APP_ENV,
            },
        )
        return (
            jsonify(
                {
                    "error": "internal_error",
                    "message": "Unable to fetch attendance records.",
                    "details": str(error),
                }
            ),
            500,
        )


    # ─── Attendance Summary (Real-time Dashboard) ─────────────────────────

    @app.route("/api/attendance/summary", methods=["GET"])
    @require_admin
    def api_attendance_summary():
        """Real-time attendance summary for the dashboard.

        Returns aggregated stats: present, absent, late, leave, overtime,
        work hours, and attendance percentage for the given date.
        """
        date_str = request.args.get("date", "")
        if not date_str:
            date_str = ist_now().strftime("%Y-%m-%d")

        try:
            summary = attendance_manager.get_attendance_summary(date_str)
            return jsonify(summary)
        except Exception as error:
            logger.exception("attendance_summary_failed")
            return jsonify({"error": "internal_error", "message": str(error)}), 500


    # ─── Break Event Logging ──────────────────────────────────────────────

    @app.route("/api/attendance/break", methods=["POST"])
    @require_admin
    def api_attendance_break():
        """Log a break start or break end event for an employee.

        Body: { "employee_name": "...", "event_type": "break_start" | "break_end" }
        """
        payload = request.get_json(silent=True) or {}
        employee_name = str(payload.get("employee_name", "")).strip()
        event_type = str(payload.get("event_type", "break_start")).strip()

        if not employee_name:
            return jsonify({"message": "employee_name is required"}), 400
        if event_type not in ("break_start", "break_end"):
            return jsonify({"message": "event_type must be break_start or break_end"}), 400

        try:
            result = attendance_manager.log_break_event(employee_name, event_type)
            if result.get("status") == "error":
                return jsonify(result), 400
            return jsonify(result)
        except Exception as error:
            logger.exception("break_event_failed")
            return jsonify({"error": "internal_error", "message": str(error)}), 500

    def _parse_analytics_range_args():
        range_key = str(request.args.get("range", "week")).strip().lower() or "week"
        if range_key not in {"day", "week", "month", "custom"}:
            raise ValueError("range must be one of: day, week, month, custom")

        today = ist_now().date()
        from_raw = str(request.args.get("from_date", "")).strip()
        to_raw = str(request.args.get("to_date", "")).strip()

        if from_raw or to_raw:
            if not from_raw or not to_raw:
                raise ValueError("from_date and to_date must both be provided")
            start_date = datetime.strptime(from_raw, "%Y-%m-%d").date()
            end_date = datetime.strptime(to_raw, "%Y-%m-%d").date()
        elif range_key == "day":
            start_date = today
            end_date = today
        elif range_key == "month":
            start_date = today - timedelta(days=29)
            end_date = today
        else:
            # week and default
            start_date = today - timedelta(days=6)
            end_date = today

        if start_date > end_date:
            raise ValueError("from_date cannot be after to_date")
        if (end_date - start_date).days > 365:
            raise ValueError("Date range cannot exceed 365 days")

        return {
            "range": range_key,
            "start_date": start_date,
            "end_date": end_date,
            "department": str(request.args.get("department", "")).strip(),
            "employee": str(request.args.get("employee", "")).strip(),
        }


def _attendance_row_is_leave(row: dict) -> bool:
    status_text = str((row or {}).get("status") or "").strip().lower()
    timing_text = str((row or {}).get("timing_status") or "").strip().lower()
    return bool((row or {}).get("leave_marked")) or status_text == "leave" or timing_text == "on leave"


def _attendance_row_is_absent(row: dict) -> bool:
    if _attendance_row_is_leave(row):
        return False
    status_text = str(row.get("status") or "").strip().lower()
    if status_text == "absent" or bool(row.get("auto_absent")):
        return True
    return not row.get("check_in") and not row.get("check_out")


def _attendance_row_is_late(row: dict) -> bool:
    status_text = str(row.get("status") or "").strip().lower()
    if status_text == "late":
        return True
    timing = str(row.get("timing_status") or row.get("entry_status") or "").strip().lower()
    return "late" in timing


def _attendance_row_work_minutes(row: dict) -> int:
    def _to_minutes(value):
        text = str(value or "").strip()
        m = re.match(r"^(\d{1,2}):(\d{2})", text)
        if not m:
            return None
        h = int(m.group(1))
        mm = int(m.group(2))
        if h < 0 or h > 23 or mm < 0 or mm > 59:
            return None
        return (h * 60) + mm

    in_min = _to_minutes(row.get("check_in"))
    out_min = _to_minutes(row.get("check_out"))
    if in_min is None or out_min is None:
        return 0
    diff = out_min - in_min
    if diff < 0:
        diff += 24 * 60
    return max(0, diff)


def _dashboard_summary_for_date(date_text: Optional[str] = None) -> dict:
    target_date = str(date_text or ist_now().strftime("%Y-%m-%d")).strip()
    try:
        target_date = datetime.strptime(target_date, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        raise ValueError("Invalid date format. Use YYYY-MM-DD.")

    attendance_manager.auto_mark_absent_for_date(target_date)

    employees = list(db.employees.find({}, {"_id": 1, "status": 1, "is_active": 1, "active": 1}))
    all_employee_ids = {str(row.get("_id")) for row in employees if row.get("_id") is not None}

    attendance_rows = list(db.attendance.find({"date": target_date}))
    present_ids = set()
    absent_ids = set()
    late_ids = set()
    leave_ids = set()

    for row in attendance_rows:
        employee_id = str(row.get("employee_id") or "").strip()
        if not employee_id:
            continue

        is_leave = _attendance_row_is_leave(row)
        is_absent = _attendance_row_is_absent(row)
        is_late = _attendance_row_is_late(row)
        is_present = (not is_leave) and (not is_absent) and (bool(row.get("check_in")) or bool(row.get("check_out")))

        if is_leave:
            leave_ids.add(employee_id)
        elif is_present:
            present_ids.add(employee_id)
            if is_late:
                late_ids.add(employee_id)
        elif is_absent:
            absent_ids.add(employee_id)

    unresolved_absent = all_employee_ids - present_ids - leave_ids - absent_ids
    absent_ids.update(unresolved_absent)

    pending_manual = db.manual_requests.count_documents({"status": "pending"})
    pending_leave = db.leave_requests.count_documents({"status": "pending"})

    return {
        "date": target_date,
        "total_employees": len(all_employee_ids),
        "present": len(present_ids),
        "absent": len(absent_ids),
        "late": len(late_ids),
        "on_leave": len(leave_ids),
        "pending_requests": int(pending_manual) + int(pending_leave),
        "pending_manual_requests": int(pending_manual),
        "pending_leave_requests": int(pending_leave),
    }


@app.get("/api/dashboard/summary")
@admin_auth_required
def api_dashboard_summary():
    try:
        payload = _dashboard_summary_for_date(request.args.get("date"))
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400
    return jsonify(payload)


def _get_company_employee_ids(company_id: str):
    """ObjectIds for employees in this company — strict tenant isolation (no global fallback)."""
    cid = str(company_id or "").strip()
    if not cid:
        return []
    return list_company_employee_object_ids(db, cid)


def _employee_is_active_row(row: dict) -> bool:
    if not isinstance(row, dict):
        return False
    status_text = str(row.get("status") or "").strip().lower()
    if status_text == "inactive":
        return False
    if isinstance(row.get("is_active"), bool):
        return bool(row.get("is_active"))
    if isinstance(row.get("active"), bool):
        return bool(row.get("active"))
    return True


def _resolve_company_id_for_user_directory(employee_doc: dict) -> str:
    """Company id used with employees_match_query_for_company for directory listing."""
    if not isinstance(employee_doc, dict):
        return "PR"
    cid = str(employee_doc.get("company_id") or "").strip()
    if cid and db.companies.find_one({"id": cid}, {"_id": 1}):
        return cid
    cname = str(employee_doc.get("company_name") or "").strip()
    if not cname:
        return "PR"
    comp = db.companies.find_one({
        "$or": [
            {"id": {"$regex": f"^{re.escape(cname)}$", "$options": "i"}},
            {"name": {"$regex": f"^{re.escape(cname)}$", "$options": "i"}},
            {"companyCode": {"$regex": f"^{re.escape(cname)}$", "$options": "i"}},
        ]
    })
    if comp and str(comp.get("id") or "").strip():
        return str(comp.get("id")).strip()
    return cname


def _time_text_to_minutes(value) -> Optional[int]:
    text = str(value or "").strip()
    m = re.match(r"^(\d{1,2}):(\d{2})", text)
    if not m:
        return None
    hh = int(m.group(1))
    mm = int(m.group(2))
    if hh < 0 or hh > 23 or mm < 0 or mm > 59:
        return None
    return (hh * 60) + mm


def _build_attendance_alerts(date_text: Optional[str] = None, limit: int = 5) -> dict:
    target_date = str(date_text or ist_now().strftime("%Y-%m-%d")).strip()
    try:
        parsed_target_date = datetime.strptime(target_date, "%Y-%m-%d").date()
        target_date = parsed_target_date.strftime("%Y-%m-%d")
    except ValueError:
        raise ValueError("Invalid date format. Use YYYY-MM-DD.")

    attendance_manager.auto_mark_absent_for_date(target_date)

    try:
        shift_start_minutes = max(0, min(23 * 60 + 59, int(request.args.get("shift_start_minutes") or (9 * 60 + 30))))
    except (TypeError, ValueError):
        shift_start_minutes = 9 * 60 + 30

    try:
        workday_end_minutes = max(0, min(23 * 60 + 59, int(request.args.get("workday_end_minutes") or (18 * 60))))
    except (TypeError, ValueError):
        workday_end_minutes = 18 * 60

    employees = list(db.employees.find({}, {"_id": 1, "name": 1, "status": 1, "is_active": 1, "active": 1}))
    active_employees = [row for row in employees if _employee_is_active_row(row) and row.get("_id") is not None]
    employee_name_map = {
        str(row.get("_id")): str(row.get("name") or "Employee").strip() or "Employee"
        for row in active_employees
    }

    attendance_rows = list(db.attendance.find({"date": target_date}))
    attendance_by_employee = {}
    for row in attendance_rows:
        employee_id = str(row.get("employee_id") or "").strip()
        if employee_id:
            attendance_by_employee[employee_id] = row

    now_local = ist_now()
    today_key = now_local.strftime("%Y-%m-%d")
    now_minutes = (now_local.hour * 60) + now_local.minute

    alerts = []
    for employee in active_employees:
        employee_id = str(employee.get("_id") or "").strip()
        if not employee_id:
            continue
        employee_name = employee_name_map.get(employee_id) or "Employee"
        row = attendance_by_employee.get(employee_id)

        if not row:
            alerts.append(
                {
                    "id": f"no-attendance-{target_date}-{employee_id}",
                    "type": "no_attendance",
                    "level": "missing",
                    "employeeId": employee_id,
                    "employeeName": employee_name,
                    "issue": "No Attendance",
                    "message": f"{employee_name} has no attendance marked for {target_date}.",
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                    "time": target_date,
                }
            )
            continue

        if _attendance_row_is_leave(row):
            continue

        check_in_minutes = _time_text_to_minutes(row.get("check_in"))
        is_late = _attendance_row_is_late(row) or (
            check_in_minutes is not None and check_in_minutes > shift_start_minutes
        )
        if is_late:
            alerts.append(
                {
                    "id": f"late-{target_date}-{employee_id}",
                    "type": "late_coming",
                    "level": "late",
                    "employeeId": employee_id,
                    "employeeName": employee_name,
                    "issue": "Late",
                    "message": f"{employee_name} checked in late.",
                    "createdAt": str(row.get("updated_at") or row.get("check_in_at") or datetime.now(timezone.utc).isoformat()),
                    "time": str(row.get("check_in") or ""),
                }
            )

        has_check_in = bool(str(row.get("check_in") or "").strip()) or bool(str(row.get("check_in_at") or "").strip())
        has_check_out = bool(str(row.get("check_out") or "").strip()) or bool(str(row.get("check_out_at") or "").strip())
        should_check_missing_checkout = (target_date < today_key) or (target_date == today_key and now_minutes >= workday_end_minutes)
        if has_check_in and (not has_check_out) and should_check_missing_checkout:
            alerts.append(
                {
                    "id": f"missing-checkout-{target_date}-{employee_id}",
                    "type": "missed_checkout",
                    "level": "missing",
                    "employeeId": employee_id,
                    "employeeName": employee_name,
                    "issue": "Missing Check-Out",
                    "message": f"{employee_name} has not checked out.",
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                    "time": target_date,
                }
            )

    weekly_start = (parsed_target_date - timedelta(days=6)).strftime("%Y-%m-%d")
    weekly_end = target_date
    week_days = [
        (parsed_target_date - timedelta(days=offset)).strftime("%Y-%m-%d")
        for offset in range(6, -1, -1)
    ]
    weekly_rows = list(db.attendance.find({"date": {"$gte": weekly_start, "$lte": weekly_end}}))
    weekly_lookup = {}
    for row in weekly_rows:
        eid = str(row.get("employee_id") or "").strip()
        day = str(row.get("date") or "").strip()
        if eid and day:
            weekly_lookup[(eid, day)] = row

    for employee in active_employees:
        employee_id = str(employee.get("_id") or "").strip()
        if not employee_id:
            continue
        employee_name = employee_name_map.get(employee_id) or "Employee"
        absent_days = 0
        for day in week_days:
            row = weekly_lookup.get((employee_id, day))
            if not row:
                absent_days += 1
                continue
            if _attendance_row_is_leave(row):
                continue
            if _attendance_row_is_absent(row):
                absent_days += 1

        if absent_days > 3:
            alerts.append(
                {
                    "id": f"high-absenteeism-{target_date}-{employee_id}",
                    "type": "high_absenteeism",
                    "level": "warning",
                    "employeeId": employee_id,
                    "employeeName": employee_name,
                    "issue": "High Absenteeism",
                    "message": f"{employee_name} absent for {absent_days} days in the last 7 days.",
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                    "time": f"{absent_days}/7 days",
                }
            )

    priority = {"missing": 0, "warning": 1, "late": 2}
    def _alert_sort_key(row: dict):
        created = str(row.get("createdAt") or "")
        created_dt = _parse_iso_datetime(created)
        created_ts = created_dt.timestamp() if created_dt else 0
        return (
            priority.get(str(row.get("level") or "").strip().lower(), 9),
            -created_ts,
            str(row.get("employeeName") or "").lower(),
        )

    alerts.sort(key=_alert_sort_key)

    limit_value = max(1, min(50, int(limit or 5)))
    return {
        "date": target_date,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "total": len(alerts),
        "items": alerts[:limit_value],
    }


def _parse_iso_datetime(value: str) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None


_REPORTS_ATTENDANCE_CACHE = {}
_REPORTS_ATTENDANCE_CACHE_TTL_SECONDS = 20


def _parse_reports_attendance_args():
    from_raw = str(request.args.get("from") or request.args.get("from_date") or "").strip()
    to_raw = str(request.args.get("to") or request.args.get("to_date") or "").strip()

    today = ist_now().date()
    if from_raw and to_raw:
        start_date = datetime.strptime(from_raw, "%Y-%m-%d").date()
        end_date = datetime.strptime(to_raw, "%Y-%m-%d").date()
    elif from_raw or to_raw:
        raise ValueError("from and to must both be provided")
    else:
        end_date = today
        start_date = today - timedelta(days=6)

    if start_date > end_date:
        raise ValueError("from cannot be after to")
    if (end_date - start_date).days > 365:
        raise ValueError("Date range cannot exceed 365 days")

    try:
        page = max(1, int(request.args.get("page") or 1))
    except (TypeError, ValueError):
        page = 1
    try:
        limit = max(1, min(200, int(request.args.get("limit") or 20)))
    except (TypeError, ValueError):
        limit = 20

    sort_by = str(request.args.get("sortBy") or "date").strip()
    if sort_by not in {"date", "employeeName", "status", "workingHours"}:
        sort_by = "date"

    sort_dir_text = str(request.args.get("sortDir") or "desc").strip().lower()
    sort_dir = -1 if sort_dir_text == "desc" else 1

    return {
        "from": start_date.strftime("%Y-%m-%d"),
        "to": end_date.strftime("%Y-%m-%d"),
        "department": str(request.args.get("department") or "").strip(),
        "employee_id": str(request.args.get("employeeId") or request.args.get("employee") or "").strip(),
        "company_id": str(request.args.get("company_id") or "").strip(),
        "status": str(request.args.get("status") or "").strip().lower(),
        "search": str(request.args.get("search") or "").strip(),
        "page": page,
        "limit": limit,
        "sort_by": sort_by,
        "sort_dir": sort_dir,
    }


def _reports_attendance_cache_key(parsed: dict) -> str:
    return json.dumps(parsed, sort_keys=True, default=str)


def _reports_attendance_base_pipeline(parsed: dict):
    from bson import ObjectId
    from bson.errors import InvalidId

    match_stage = {
        "date": {"$gte": parsed["from"], "$lte": parsed["to"]},
    }

    employee_filter = str(parsed.get("employee_id") or "").strip()
    if employee_filter:
        employee_or_filters = []
        try:
            employee_or_filters.append({"employee_id": ObjectId(employee_filter)})
        except InvalidId:
            pass
        employee_or_filters.append({"employee_id": employee_filter})
        match_stage["$or"] = employee_or_filters

    base = [
        {"$match": match_stage},
        {
            "$lookup": {
                "from": "employees",
                "localField": "employee_id",
                "foreignField": "_id",
                "as": "employee",
            }
        },
        {"$unwind": {"path": "$employee", "preserveNullAndEmptyArrays": True}},
    ]

    company_scope = str(parsed.get("company_id") or "").strip()
    if company_scope:
        company_oids = list_company_employee_object_ids(db, company_scope)
        base.append({"$match": {"employee._id": {"$in": company_oids}}})

    if employee_filter:
        base.append(
            {
                "$match": {
                    "$or": [
                        {"employee.login_id": employee_filter},
                        {"employee_id": employee_filter},
                        {"$expr": {"$eq": [{"$toString": "$employee._id"}, employee_filter]}},
                    ]
                }
            }
        )

    department = str(parsed.get("department") or "").strip()
    if department:
        base.append({"$match": {"employee.department": department}})

    status_filter = str(parsed.get("status") or "").strip().lower()
    if status_filter in {"present", "absent", "late", "leave"}:
        if status_filter == "leave":
            base.append({
                "$match": {
                    "$or": [
                        {"status": {"$in": ["leave", "leave_marked"]}},
                        {"timing_status": {"$regex": "on leave", "$options": "i"}},
                        {"leave_marked": True},
                    ]
                }
            })
        elif status_filter == "absent":
            base.append({"$match": {"status": "absent"}})
        elif status_filter == "late":
            base.append({
                "$match": {
                    "$or": [
                        {"status": "late"},
                        {"timing_status": {"$regex": "late", "$options": "i"}},
                        {"entry_status": {"$regex": "late", "$options": "i"}},
                    ]
                }
            })
        elif status_filter == "present":
            base.append({
                "$match": {
                    "$and": [
                        {"status": {"$nin": ["absent", "leave", "leave_marked"]}},
                        {
                            "$or": [
                                {"check_in": {"$type": "string", "$ne": ""}},
                                {"check_out": {"$type": "string", "$ne": ""}},
                            ]
                        },
                    ]
                }
            })

    search = str(parsed.get("search") or "").strip()
    if search:
        safe = re.escape(search)
        base.append({
            "$match": {
                "$or": [
                    {"employee.name": {"$regex": safe, "$options": "i"}},
                    {"employee.login_id": {"$regex": safe, "$options": "i"}},
                    {"employee_name": {"$regex": safe, "$options": "i"}},
                ]
            }
        })

    base.append(
        {
            "$addFields": {
                "employeeName": {
                    "$ifNull": ["$employee.name", {"$ifNull": ["$employee_name", "Employee"]}]
                },
                "employeeLoginId": {"$ifNull": ["$employee.login_id", ""]},
                "departmentName": {"$ifNull": ["$employee.department", "General"]},
                "statusRaw": {"$toLower": {"$ifNull": ["$status", ""]}},
                "timingStatusRaw": {"$toLower": {"$ifNull": ["$timing_status", ""]}},
                "entryStatusRaw": {"$toLower": {"$ifNull": ["$entry_status", ""]}},
                "checkInText": {"$ifNull": ["$check_in", ""]},
                "checkOutText": {"$ifNull": ["$check_out", ""]},
            }
        }
    )

    base.append(
        {
            "$addFields": {
                "isLeave": {
                    "$or": [
                        {"$eq": ["$statusRaw", "leave"]},
                        {"$eq": ["$statusRaw", "leave_marked"]},
                        {"$regexMatch": {"input": "$timingStatusRaw", "regex": "on leave"}},
                        {"$eq": [{"$ifNull": ["$leave_marked", False]}, True]},
                    ]
                },
                "isAbsent": {
                    "$or": [
                        {"$eq": ["$statusRaw", "absent"]},
                        {"$eq": [{"$ifNull": ["$auto_absent", False]}, True]},
                    ]
                },
                "isLate": {
                    "$or": [
                        {"$eq": ["$statusRaw", "late"]},
                        {"$regexMatch": {"input": "$timingStatusRaw", "regex": "late"}},
                        {"$regexMatch": {"input": "$entryStatusRaw", "regex": "late"}},
                    ]
                },
                "checkInHours": {"$convert": {"input": {"$arrayElemAt": [{"$split": ["$checkInText", ":"]}, 0]}, "to": "int", "onError": 0, "onNull": 0}},
                "checkInMinutes": {"$convert": {"input": {"$arrayElemAt": [{"$split": ["$checkInText", ":"]}, 1]}, "to": "int", "onError": 0, "onNull": 0}},
                "checkOutHours": {"$convert": {"input": {"$arrayElemAt": [{"$split": ["$checkOutText", ":"]}, 0]}, "to": "int", "onError": 0, "onNull": 0}},
                "checkOutMinutes": {"$convert": {"input": {"$arrayElemAt": [{"$split": ["$checkOutText", ":"]}, 1]}, "to": "int", "onError": 0, "onNull": 0}},
            }
        }
    )

    base.append(
        {
            "$addFields": {
                "isPresent": {
                    "$and": [
                        {"$not": ["$isLeave"]},
                        {"$not": ["$isAbsent"]},
                        {
                            "$or": [
                                {"$gt": [{"$strLenCP": "$checkInText"}, 0]},
                                {"$gt": [{"$strLenCP": "$checkOutText"}, 0]},
                            ]
                        },
                    ]
                },
                "checkInTotalMinutes": {"$add": [{"$multiply": ["$checkInHours", 60]}, "$checkInMinutes"]},
                "checkOutTotalMinutes": {"$add": [{"$multiply": ["$checkOutHours", 60]}, "$checkOutMinutes"]},
            }
        }
    )

    base.append(
        {
            "$addFields": {
                "workingMinutes": {
                    "$cond": [
                        {
                            "$and": [
                                {"$regexMatch": {"input": "$checkInText", "regex": "^\\d{1,2}:\\d{2}"}},
                                {"$regexMatch": {"input": "$checkOutText", "regex": "^\\d{1,2}:\\d{2}"}},
                            ]
                        },
                        {
                            "$cond": [
                                {"$gte": ["$checkOutTotalMinutes", "$checkInTotalMinutes"]},
                                {"$subtract": ["$checkOutTotalMinutes", "$checkInTotalMinutes"]},
                                {"$add": [{"$subtract": [1440, "$checkInTotalMinutes"]}, "$checkOutTotalMinutes"]},
                            ]
                        },
                        0,
                    ]
                },
                "statusBucket": {
                    "$cond": [
                        "$isLeave",
                        "leave",
                        {
                            "$cond": [
                                "$isAbsent",
                                "absent",
                                {
                                    "$cond": ["$isLate", "late", "present"]
                                },
                            ]
                        },
                    ]
                },
            }
        }
    )

    return base


def _compute_reports_attendance_payload(parsed: dict):
    base = _reports_attendance_base_pipeline(parsed)

    summary_rows = list(db.attendance.aggregate(base + [
        {
            "$group": {
                "_id": None,
                "present": {"$sum": {"$cond": ["$isPresent", 1, 0]}},
                "absent": {"$sum": {"$cond": ["$isAbsent", 1, 0]}},
                "late": {"$sum": {"$cond": ["$isLate", 1, 0]}},
                "totalHours": {"$sum": {"$divide": ["$workingMinutes", 60]}},
            }
        },
        {
            "$project": {
                "_id": 0,
                "present": 1,
                "absent": 1,
                "late": 1,
                "totalHours": {"$round": ["$totalHours", 1]},
                "attendanceRate": {
                    "$round": [
                        {
                            "$multiply": [
                                {
                                    "$cond": [
                                        {"$gt": [{"$add": ["$present", "$absent"]}, 0]},
                                        {"$divide": ["$present", {"$add": ["$present", "$absent"]}]},
                                        0,
                                    ]
                                },
                                100,
                            ]
                        },
                        1,
                    ]
                },
            }
        },
    ]))
    summary = summary_rows[0] if summary_rows else {
        "present": 0,
        "absent": 0,
        "late": 0,
        "totalHours": 0,
        "attendanceRate": 0,
    }

    trends = list(db.attendance.aggregate(base + [
        {
            "$group": {
                "_id": "$date",
                "present": {"$sum": {"$cond": ["$isPresent", 1, 0]}},
                "absent": {"$sum": {"$cond": ["$isAbsent", 1, 0]}},
            }
        },
        {"$sort": {"_id": 1}},
        {
            "$project": {
                "_id": 0,
                "date": "$_id",
                "present": 1,
                "absent": 1,
            }
        },
    ]))

    department_stats = list(db.attendance.aggregate(base + [
        {
            "$group": {
                "_id": "$departmentName",
                "count": {"$sum": 1},
                "present": {"$sum": {"$cond": ["$isPresent", 1, 0]}},
            }
        },
        {"$sort": {"count": -1, "_id": 1}},
        {
            "$project": {
                "_id": 0,
                "department": {"$ifNull": ["$_id", "General"]},
                "count": 1,
                "present": 1,
            }
        },
    ]))

    total_rows_doc = list(db.attendance.aggregate(base + [{"$count": "total"}]))
    total_rows = int(total_rows_doc[0].get("total", 0)) if total_rows_doc else 0

    sort_field_map = {
        "date": "date",
        "employeeName": "employeeName",
        "status": "statusBucket",
        "workingHours": "workingMinutes",
    }
    sort_field = sort_field_map.get(parsed.get("sort_by"), "date")
    sort_dir = int(parsed.get("sort_dir") or -1)
    page = int(parsed.get("page") or 1)
    limit = int(parsed.get("limit") or 20)
    skip = max(0, (page - 1) * limit)

    table_rows = list(db.attendance.aggregate(base + [
        {"$sort": {sort_field: sort_dir, "date": -1, "employeeName": 1}},
        {"$skip": skip},
        {"$limit": limit},
        {
            "$project": {
                "_id": 0,
                "employeeId": {"$toString": {"$ifNull": ["$employee._id", "$employee_id"]}},
                "employeeName": "$employeeName",
                "date": "$date",
                "checkIn": "$checkInText",
                "checkOut": "$checkOutText",
                "status": "$statusBucket",
                "department": "$departmentName",
                "workingHours": {"$round": [{"$divide": ["$workingMinutes", 60]}, 2]},
            }
        },
    ]))

    total_pages = max(1, math.ceil(total_rows / max(1, limit)))
    departments = sorted(
        [str(v).strip() for v in db.employees.distinct("department") if str(v).strip()],
        key=lambda x: x.lower(),
    )

    return {
        "summary": {
            "present": int(summary.get("present", 0)),
            "absent": int(summary.get("absent", 0)),
            "late": int(summary.get("late", 0)),
            "totalHours": float(summary.get("totalHours", 0) or 0),
            "attendanceRate": float(summary.get("attendanceRate", 0) or 0),
        },
        "trends": trends,
        "departmentStats": department_stats,
        "tableData": table_rows,
        "pagination": {
            "page": page,
            "limit": limit,
            "total": total_rows,
            "totalPages": total_pages,
            "hasNext": page < total_pages,
            "hasPrev": page > 1,
        },
        "filters": {
            "departments": departments,
            "statuses": ["all", "present", "absent", "late", "leave"],
        },
        "query": {
            "from": parsed.get("from"),
            "to": parsed.get("to"),
            "department": parsed.get("department"),
            "employeeId": parsed.get("employee_id"),
            "companyId": parsed.get("company_id"),
            "status": parsed.get("status"),
            "search": parsed.get("search"),
            "sortBy": parsed.get("sort_by"),
            "sortDir": "desc" if int(parsed.get("sort_dir") or -1) == -1 else "asc",
        },
        "generatedAt": ist_now().isoformat(),
    }


@app.get("/reports/attendance")
@app.get("/api/reports/attendance")
@admin_auth_required
def api_reports_attendance():
    try:
        parsed = _parse_reports_attendance_args()
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    cache_key = _reports_attendance_cache_key(parsed)
    now_ts = time.time()
    cached = _REPORTS_ATTENDANCE_CACHE.get(cache_key)
    if cached and (now_ts - float(cached.get("at", 0))) <= _REPORTS_ATTENDANCE_CACHE_TTL_SECONDS:
        return jsonify(cached.get("payload") or {})

    try:
        payload = _compute_reports_attendance_payload(parsed)
        _REPORTS_ATTENDANCE_CACHE[cache_key] = {"at": now_ts, "payload": payload}
        return jsonify(payload)
    except Exception as exc:
        logger.exception("reports_attendance_failed")
        return jsonify({"message": "Failed to build attendance report", "details": str(exc)}), 500


@app.get("/api/alerts")
@admin_auth_required
def api_get_alerts():
    try:
        limit = int(request.args.get("limit") or 5)
    except (TypeError, ValueError):
        limit = 5

    company_id = str(request.args.get("company_id") or "").strip()

    try:
        payload = _build_attendance_alerts(request.args.get("date"), limit=limit)
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    if company_id:
        company_employee_ids = _get_company_employee_ids(company_id)
        str_ids = {str(eid) for eid in company_employee_ids}
        items = payload.get("items") or []
        payload["items"] = [item for item in items if str(item.get("employee_id") or "") in str_ids]
        payload["total"] = len(payload["items"])

    return jsonify(payload)


def _notification_actor():
    auth = _decode_any_bearer_claims()
    if auth.get("error"):
        message, code = auth.get("error")
        return None, None, None, (jsonify({"message": message}), code)

    role = str(auth.get("role") or "").strip().lower()
    claims = auth.get("claims") or {}
    user_id = ""
    if role == "user":
        user_id = str(claims.get("employee_id") or "").strip()
    return role, claims, user_id, None


@app.get("/api/notifications")
def api_get_notifications():
    role, claims, user_id, error = _notification_actor()
    if error:
        return error

    if role == "admin":
        query = {}
    else:
        query = {"userId": user_id}

    notif_type = str(request.args.get("type") or "").strip().lower()
    if notif_type in {"employee", "attendance", "leave", "request"}:
        query["type"] = notif_type

    category = str(request.args.get("category") or "").strip().lower()
    if category:
        query["category"] = category

    priority = str(request.args.get("priority") or "").strip().lower()
    if priority in {"high", "medium", "low"}:
        query["priority"] = priority

    unread_only = str(request.args.get("unread") or "").strip().lower() in {"1", "true", "yes", "on"}
    if unread_only:
        query["isRead"] = False

    include_archived = str(request.args.get("archived") or "").strip().lower() in {"1", "true", "yes", "on"}
    if not include_archived:
        query["$and"] = query.get("$and", []) + [{"$or": [{"archived": False}, {"archived": {"$exists": False}}]}]

    search = str(request.args.get("search") or "").strip()
    if search:
        safe = re.escape(search)
        query["$and"] = query.get("$and", []) + [
            {
                "$or": [
                    {"title": {"$regex": safe, "$options": "i"}},
                    {"message": {"$regex": safe, "$options": "i"}},
                    {"category": {"$regex": safe, "$options": "i"}},
                    {"type": {"$regex": safe, "$options": "i"}},
                ]
            }
        ]

    try:
        limit = max(1, min(100, int(request.args.get("limit") or 30)))
    except (TypeError, ValueError):
        limit = 30

    rows = list(db.notifications.find(query).sort("createdAt", -1).limit(limit))
    items = [_serialize_notification(row) for row in rows]
    unread_count = sum(1 for item in items if not bool(item.get("isRead")))
    return jsonify({"items": items, "unread": unread_count, "total": len(items)})


@app.post("/api/notifications")
def api_create_notification():
    role, claims, user_id, error = _notification_actor()
    if error:
        return error
    if role != "admin":
        return jsonify({"message": "Only admin can create notifications"}), 403

    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title") or "Notification").strip() or "Notification"
    message = str(payload.get("message") or "").strip()
    notif_type = str(payload.get("type") or "request").strip().lower()
    category = str(payload.get("category") or notif_type or "general").strip().lower()
    priority = str(payload.get("priority") or "medium").strip().lower()
    target_user_id = str(payload.get("userId") or "").strip()

    if not message:
        return jsonify({"message": "message is required"}), 400

    notification_id = create_notification(
        message,
        notif_type,
        target_user_id,
        title=title,
        priority=priority,
        category=category,
    )
    if not notification_id:
        return jsonify({"message": "Unable to create notification"}), 500

    from bson import ObjectId
    row = db.notifications.find_one({"_id": ObjectId(notification_id)})
    return jsonify({"message": "Notification created", "notification": _serialize_notification(row)}), 201


@app.put("/api/notifications/<notification_id>/read")
def api_mark_notification_read(notification_id):
    role, claims, user_id, error = _notification_actor()
    if error:
        return error

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(notification_id)
    except InvalidId:
        return jsonify({"message": "Invalid notification id"}), 400

    row = db.notifications.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Notification not found"}), 404

    if role != "admin":
        owner = str(row.get("userId") or "").strip()
        if owner != user_id:
            return jsonify({"message": "Forbidden"}), 403

    db.notifications.update_one({"_id": oid}, {"$set": {"isRead": True}})
    persist_mock_db_now()
    updated = db.notifications.find_one({"_id": oid})
    return jsonify({"message": "Notification marked as read", "notification": _serialize_notification(updated)})


@app.put("/api/notifications/read_all")
def api_mark_all_notifications_read():
    role, claims, user_id, error = _notification_actor()
    if error:
        return error

    if role == "admin":
        query = {"isRead": False}
    else:
        query = {"isRead": False, "userId": user_id}

    result = db.notifications.update_many(query, {"$set": {"isRead": True}})
    persist_mock_db_now()
    return jsonify({"message": "Notifications marked as read", "updated": int(result.modified_count)})


@app.put("/api/notifications/<notification_id>/archive")
def api_archive_notification(notification_id):
    role, claims, user_id, error = _notification_actor()
    if error:
        return error

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(notification_id)
    except InvalidId:
        return jsonify({"message": "Invalid notification id"}), 400

    row = db.notifications.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Notification not found"}), 404

    if role != "admin":
        owner = str(row.get("userId") or "").strip()
        if owner != user_id:
            return jsonify({"message": "Forbidden"}), 403

    payload = request.get_json(silent=True) or {}
    archived = bool(payload.get("archived", True))
    db.notifications.update_one({"_id": oid}, {"$set": {"archived": archived}})
    persist_mock_db_now()
    updated = db.notifications.find_one({"_id": oid})
    return jsonify({"message": "Notification updated", "notification": _serialize_notification(updated)})


@app.get("/api/helpdesk/tickets")
@admin_auth_required
def admin_list_helpdesk_tickets():
    status = str(request.args.get("status") or "").strip().lower()
    category = str(request.args.get("category") or "").strip().lower()
    search = str(request.args.get("search") or "").strip()

    query = {}
    if status in SUPPORT_TICKET_STATUSES:
        query["status"] = status
    if category in SUPPORT_TICKET_CATEGORIES:
        query["category"] = category
    if search:
        safe = re.escape(search)
        query["$or"] = [
            {"ticket_id": {"$regex": safe, "$options": "i"}},
            {"subject": {"$regex": safe, "$options": "i"}},
            {"employee_name": {"$regex": safe, "$options": "i"}},
        ]

    rows = list(db.support_tickets.find(query).sort("created_at", -1).limit(500))
    return jsonify([_serialize_support_ticket(row) for row in rows])


@app.post("/api/helpdesk/tickets/<ticket_id>/assign")
@admin_auth_required
def admin_assign_helpdesk_ticket(ticket_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(ticket_id)
    except InvalidId:
        return jsonify({"message": "Invalid ticket id"}), 400

    row = db.support_tickets.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Ticket not found"}), 404

    payload = request.get_json(silent=True) or {}
    assigned_to = str(payload.get("assigned_to") or "").strip()
    assigned_team = str(payload.get("assigned_team") or "").strip()
    admin_remarks = str(payload.get("admin_remarks") or payload.get("remark") or "Assigned by admin").strip()

    now = ist_now()
    db.support_tickets.update_one(
        {"_id": oid},
        {
            "$set": {
                "assigned_to": assigned_to,
                "assigned_team": assigned_team,
                "admin_remarks": admin_remarks,
                "status": "in_progress",
                "updated_at": now,
            }
        },
    )
    persist_mock_db_now()
    updated = db.support_tickets.find_one({"_id": oid})
    create_notification(
        f"Ticket {row.get('ticket_id')} assigned to {assigned_to or assigned_team or 'support team'}",
        "request",
        str(row.get("employee_id") or ""),
        title="Ticket Assigned",
        priority=str(row.get("priority") or "medium"),
        category="helpdesk",
    )
    return jsonify({"message": "Ticket assigned", "ticket": _serialize_support_ticket(updated)})


@app.post("/api/helpdesk/tickets/<ticket_id>/status")
@admin_auth_required
def admin_update_helpdesk_ticket_status(ticket_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(ticket_id)
    except InvalidId:
        return jsonify({"message": "Invalid ticket id"}), 400

    row = db.support_tickets.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Ticket not found"}), 404

    payload = request.get_json(silent=True) or {}
    next_status = str(payload.get("status") or "").strip().lower()
    admin_remarks = str(payload.get("admin_remarks") or payload.get("remark") or "").strip()
    assigned_to = str(payload.get("assigned_to") or row.get("assigned_to") or "").strip()
    assigned_team = str(payload.get("assigned_team") or row.get("assigned_team") or "").strip()
    resolution_date = str(payload.get("resolution_date") or "").strip()

    if next_status not in SUPPORT_TICKET_STATUSES:
        return jsonify({"message": "Invalid ticket status"}), 400

    if resolution_date:
        try:
            datetime.strptime(resolution_date, "%Y-%m-%d")
        except ValueError:
            return jsonify({"message": "Invalid resolution date. Use YYYY-MM-DD"}), 400

    now = ist_now()
    updates = {
        "status": next_status,
        "admin_remarks": admin_remarks,
        "assigned_to": assigned_to,
        "assigned_team": assigned_team,
        "updated_at": now,
    }
    if resolution_date:
        updates["resolution_date"] = resolution_date
    if next_status == "resolved":
        updates["resolved_at"] = now
    if next_status == "closed":
        updates["closed_at"] = now
    if next_status == "rejected":
        updates["rejected_at"] = now

    db.support_tickets.update_one({"_id": oid}, {"$set": updates})
    persist_mock_db_now()
    updated = db.support_tickets.find_one({"_id": oid})
    create_notification(
        f"Ticket {row.get('ticket_id')} updated: {next_status.replace('_', ' ')}",
        "request",
        str(row.get("employee_id") or ""),
        title="Ticket Status Updated",
        priority=str(row.get("priority") or "medium"),
        category="helpdesk",
    )
    return jsonify({"message": "Ticket updated", "ticket": _serialize_support_ticket(updated)})


@app.get("/analytics/attendance")
@app.get("/api/analytics/attendance")
@admin_auth_required
def attendance_analytics():
    try:
        parsed = _parse_analytics_range_args()
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    start_date = parsed["start_date"]
    end_date = parsed["end_date"]
    department = parsed["department"]
    employee_key = parsed["employee"].lower()

    employee_query = {}
    if department:
        employee_query["department"] = department

    employee_rows = list(db.employees.find(employee_query, {"_id": 1, "name": 1, "login_id": 1, "department": 1}))
    employee_ids = [row.get("_id") for row in employee_rows if row.get("_id") is not None]
    employee_lookup = {}
    for row in employee_rows:
        _id = row.get("_id")
        if _id is not None:
            employee_lookup[str(_id)] = row

    if employee_key:
        employee_rows = [
            row for row in employee_rows
            if str(row.get("login_id") or "").strip().lower() == employee_key
        ]
        employee_ids = [row.get("_id") for row in employee_rows if row.get("_id") is not None]
        employee_lookup = {str(row.get("_id")): row for row in employee_rows if row.get("_id") is not None}

    if employee_ids:
        attendance_query = {
            "date": {
                "$gte": start_date.strftime("%Y-%m-%d"),
                "$lte": end_date.strftime("%Y-%m-%d"),
            },
            "employee_id": {"$in": employee_ids},
        }
    else:
        attendance_query = {
            "date": {
                "$gte": start_date.strftime("%Y-%m-%d"),
                "$lte": end_date.strftime("%Y-%m-%d"),
            },
            "employee_id": {"$in": []},
        }

    raw_rows = list(db.attendance.find(attendance_query).sort([("date", 1), ("check_in", 1)]))

    date_keys = []
    cursor = start_date
    while cursor <= end_date:
        date_keys.append(cursor.strftime("%Y-%m-%d"))
        cursor += timedelta(days=1)

    daily_present = {key: set() for key in date_keys}
    daily_absent = {key: set() for key in date_keys}
    daily_leave = {key: set() for key in date_keys}
    daily_late = {key: 0 for key in date_keys}
    dept_metrics = {}
    employee_metrics = {}
    heatmap_count = {key: 0 for key in date_keys}
    serialized_rows = []

    for raw in raw_rows:
        row = normalize_attendance_row_times(raw) or {}
        employee_id = str(row.get("employee_id") or "")
        day_key = str(row.get("date") or "").strip()
        if not day_key or day_key not in daily_present:
            continue

        employee_meta = employee_lookup.get(employee_id, {})
        employee_name = str(row.get("employee_name") or employee_meta.get("name") or "")
        department_name = str(employee_meta.get("department") or row.get("department") or "General")
        login_id = str(employee_meta.get("login_id") or "")

        is_absent = _attendance_row_is_absent(row)
        is_leave = _attendance_row_is_leave(row)
        is_late = _attendance_row_is_late(row)
        is_present = (not is_absent) and (not is_leave)

        if is_present:
            daily_present[day_key].add(employee_id)
            heatmap_count[day_key] = heatmap_count.get(day_key, 0) + 1
        elif is_leave:
            daily_leave[day_key].add(employee_id)
        elif is_absent:
            daily_absent[day_key].add(employee_id)

        if is_late:
            daily_late[day_key] = daily_late.get(day_key, 0) + 1

        bucket = dept_metrics.setdefault(department_name, {"present": 0, "total": 0})
        bucket["total"] += 1
        if is_present:
            bucket["present"] += 1

        emp_bucket = employee_metrics.setdefault(
            employee_name or "Employee",
            {
                "employeeName": employee_name or "Employee",
                "employeeLoginId": login_id,
                "department": department_name,
                "daysPresent": 0,
                "daysAbsent": 0,
                "lateCount": 0,
                "totalWorkHours": 0.0,
            },
        )
        if is_present:
            emp_bucket["daysPresent"] += 1
        else:
            emp_bucket["daysAbsent"] += 1
        if is_late:
            emp_bucket["lateCount"] += 1
        emp_bucket["totalWorkHours"] += (_attendance_row_work_minutes(row) / 60.0)

        serialized_rows.append(
            {
                "id": str(row.get("_id") or ""),
                "employee_id": employee_id,
                "employee_name": employee_name,
                "login_id": login_id,
                "department": department_name,
                "date": day_key,
                "check_in": row.get("check_in"),
                "check_out": row.get("check_out"),
                "status": "leave_marked" if is_leave else ("absent" if is_absent else ("checked_out" if row.get("check_out") else "checked_in")),
                "timing_status": row.get("timing_status") or row.get("entry_status") or row.get("exit_status") or "",
                "manual_entry": bool(row.get("manual_entry")),
            }
        )

    weekly_data = []
    for key in date_keys:
        try:
            weekday_label = datetime.strptime(key, "%Y-%m-%d").strftime("%a")
        except ValueError:
            weekday_label = key
        present_count = len(daily_present.get(key, set()))
        absent_count = len(daily_absent.get(key, set()))
        leave_count = len(daily_leave.get(key, set()))
        weekly_data.append(
            {
                "date": key,
                "day": weekday_label,
                "count": present_count,
                "present": present_count,
                "absent": absent_count,
                "on_leave": leave_count,
                "late": int(daily_late.get(key, 0)),
            }
        )

    department_data = []
    for dept, metrics in dept_metrics.items():
        total = int(metrics.get("total", 0))
        present = int(metrics.get("present", 0))
        department_data.append(
            {
                "department": dept,
                "present": present,
                "total": total,
                "attendancePct": round((present / total) * 100) if total else 0,
            }
        )
    department_data.sort(key=lambda x: x.get("attendancePct", 0), reverse=True)

    performance = []
    for metrics in employee_metrics.values():
        total_days = int(metrics["daysPresent"]) + int(metrics["daysAbsent"])
        performance_pct = round((metrics["daysPresent"] / total_days) * 100) if total_days else 0
        performance.append(
            {
                **metrics,
                "totalWorkHours": round(float(metrics["totalWorkHours"]), 1),
                "performancePct": performance_pct,
            }
        )
    performance.sort(key=lambda x: x.get("performancePct", 0), reverse=True)

    total_employees = len(employee_rows)
    present_total = sum(item.get("present", 0) for item in weekly_data)
    absent_total = sum(item.get("absent", 0) for item in weekly_data)
    leave_total = sum(item.get("on_leave", 0) for item in weekly_data)
    late_total = sum(item.get("late", 0) for item in weekly_data)

    return jsonify(
        {
            "total": total_employees,
            "present": int(present_total),
            "absent": int(absent_total),
            "on_leave": int(leave_total),
            "late": int(late_total),
            "weeklyData": weekly_data,
            "departmentData": department_data,
            "performance": performance,
            "heatmap": [{"date": key, "count": int(heatmap_count.get(key, 0))} for key in date_keys],
            "lateBreakdown": {
                "onTime": max(0, int(present_total) - int(late_total)),
                "late": int(late_total),
                "absent": int(absent_total),
            },
            "totalWorkingHours": round(sum(item.get("totalWorkHours", 0.0) for item in performance), 1),
            "rows": serialized_rows,
            "range": parsed["range"],
            "fromDate": start_date.strftime("%Y-%m-%d"),
            "toDate": end_date.strftime("%Y-%m-%d"),
            "department": department,
            "employee": parsed["employee"],
            "generatedAt": ist_now().isoformat(),
        }
    )


def _parse_history_date_range(default_days: int = 30):
    from_raw = str(request.args.get("from_date", "")).strip()
    to_raw = str(request.args.get("to_date", "")).strip()

    today_ist = ist_now().date()
    end_date = today_ist
    start_date = today_ist - timedelta(days=max(1, int(default_days)) - 1)

    if from_raw:
        start_date = datetime.strptime(from_raw, "%Y-%m-%d").date()
    if to_raw:
        end_date = datetime.strptime(to_raw, "%Y-%m-%d").date()

    if start_date > end_date:
        raise ValueError("from_date cannot be after to_date")

    if (end_date - start_date).days > 365:
        raise ValueError("Date range cannot exceed 365 days")

    return start_date.strftime("%Y-%m-%d"), end_date.strftime("%Y-%m-%d")


def _attendance_row_net_hours(row: dict) -> float:
    """Best-effort net work hours for an attendance row.
    Prefers stored `working_hours`/`net_work_hours`; otherwise computes from check_in_at/check_out_at.
    """
    for key in ("net_work_hours", "working_hours", "work_hours", "hours_worked"):
        try:
            value = float(row.get(key) or 0)
        except (TypeError, ValueError):
            value = 0.0
        if value and value > 0:
            return round(value, 2)

    check_in_iso = row.get("check_in_at")
    check_out_iso = row.get("check_out_at")
    if not check_in_iso or not check_out_iso:
        return 0.0

    def _parse_iso(text: object) -> Optional[datetime]:
        if not text:
            return None
        s = str(text).strip()
        if not s:
            return None
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(s)
        except Exception:
            return None

    start = _parse_iso(check_in_iso)
    end = _parse_iso(check_out_iso)
    if not start or not end:
        return 0.0
    diff = (end - start).total_seconds()
    if diff <= 0:
        return 0.0
    return round(diff / 3600.0, 2)


def _serialize_attendance_history_rows(rows, fallback_employee_name: str = ""):
    items = []
    for row in rows or []:
        normalized = normalize_attendance_row_times(row) or {}
        normalized["id"] = str(normalized.pop("_id", ""))
        normalized["employee_id"] = str(normalized.get("employee_id") or "")
        if fallback_employee_name and not normalized.get("employee_name"):
            normalized["employee_name"] = fallback_employee_name

        raw_status = str(normalized.get("status") or "").strip().lower()
        raw_timing = str(normalized.get("timing_status") or "").strip().lower()
        is_leave = bool(normalized.get("leave_marked")) or raw_status == "leave" or raw_timing == "on leave"
        date_text = str(normalized.get("date") or "").strip()
        is_weekend = False
        try:
            weekday = datetime.strptime(date_text, "%Y-%m-%d").weekday()
            is_weekend = weekday >= 5
        except Exception:
            is_weekend = False

        if is_leave:
            normalized["status"] = "leave_marked"
            normalized["timing_status"] = "On Leave"
        elif is_weekend and not normalized.get("check_in") and not normalized.get("check_out"):
            normalized["status"] = "holiday"
            normalized["timing_status"] = ""
        else:
            if normalized.get("check_out"):
                normalized["status"] = "checked_out"
            elif normalized.get("check_in"):
                normalized["status"] = "checked_in"
            else:
                normalized["status"] = "absent"
            normalized["timing_status"] = normalized.get("timing_status") or normalized.get("exit_status") or normalized.get("entry_status")

        normalized["manual_entry"] = bool(normalized.get("manual_entry"))
        normalized["net_work_hours"] = _attendance_row_net_hours(normalized)
        normalized.pop("created_at", None)
        normalized.pop("updated_at", None)
        items.append(normalized)
    return items


@app.get("/admin/employee_attendance_history")
@admin_auth_required
def admin_employee_attendance_history():
    employee_id = str(request.args.get("employee_id", "")).strip()
    if not employee_id:
        return jsonify({"message": "employee_id is required"}), 400

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        employee_oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    employee = db.employees.find_one({"_id": employee_oid})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    try:
        from_date, to_date = _parse_history_date_range(default_days=30)
    except ValueError as error:
        return jsonify({"message": str(error)}), 400

    today_text = ist_now().strftime("%Y-%m-%d")
    if from_date <= today_text <= to_date:
        attendance_manager.auto_mark_absent_for_date(today_text)

    rows = list(
        db.attendance.find({
            "employee_id": employee_oid,
            "date": {"$gte": from_date, "$lte": to_date},
        }).sort("date", -1)
    )

    return jsonify({
        "employee_id": employee_id,
        "employee_name": str(employee.get("name") or ""),
        "from_date": from_date,
        "to_date": to_date,
        "rows": _serialize_attendance_history_rows(rows, fallback_employee_name=str(employee.get("name") or "")),
    })


@app.get("/user/attendance_history")
@user_auth_required
def user_attendance_history():
    claims = getattr(g, "user_claims", {}) or {}
    employee_id = str(claims.get("employee_id") or "").strip()
    if not employee_id:
        return jsonify({"message": "Invalid user token"}), 401

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        employee_oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid user token"}), 401

    employee = db.employees.find_one({"_id": employee_oid})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    try:
        from_date, to_date = _parse_history_date_range(default_days=30)
    except ValueError as error:
        return jsonify({"message": str(error)}), 400

    today_text = ist_now().strftime("%Y-%m-%d")
    if from_date <= today_text <= to_date:
        attendance_manager.auto_mark_absent_for_date(today_text)

    rows = list(
        db.attendance.find({
            "employee_id": employee_oid,
            "date": {"$gte": from_date, "$lte": to_date},
        }).sort("date", -1)
    )

    return jsonify({
        "employee_id": employee_id,
        "employee_name": str(employee.get("name") or claims.get("employee_name") or ""),
        "from_date": from_date,
        "to_date": to_date,
        "rows": _serialize_attendance_history_rows(
            rows,
            fallback_employee_name=str(employee.get("name") or claims.get("employee_name") or ""),
        ),
    })


@app.get("/user/directory")
@user_auth_required
@limiter.limit("120 per hour")
def user_company_directory():
    """Active coworkers in the same company as the authenticated employee."""
    claims = getattr(g, "user_claims", {}) or {}
    employee_id = str(claims.get("employee_id") or "").strip()
    if not employee_id:
        return jsonify({"message": "Invalid user token"}), 401

    from bson.errors import InvalidId

    try:
        employee_oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid user token"}), 401

    me = db.employees.find_one({"_id": employee_oid})
    if not me:
        return jsonify({"message": "Employee not found"}), 404

    company_scope = _resolve_company_id_for_user_directory(me)
    query = employees_match_query_for_company(db, company_scope)
    docs = list(
        db.employees.find(
            query,
            {"name": 1, "login_id": 1, "department": 1, "role": 1, "designation": 1, "email": 1, "phone": 1, "mobile": 1, "status": 1, "is_active": 1, "active": 1},
        ).sort("name", 1)
    )
    out = []
    for r in docs:
        if not _employee_is_active_row(r):
            continue
        nm = str(r.get("name") or "").strip() or "Employee"
        out.append({
            "id": str(r.get("_id")),
            "name": nm,
            "login_id": str(r.get("login_id") or ""),
            "department": str(r.get("department") or "General"),
            "role": str(r.get("role") or r.get("designation") or "Staff"),
            "email": str(r.get("email") or ""),
            "phone": str(r.get("phone") or r.get("mobile") or ""),
        })
    return jsonify(out)


@app.get("/user/holidays")
@user_auth_required
@limiter.limit("120 per hour")
def user_holidays_list():
    """Company holidays for a calendar year (same collection as admin)."""
    try:
        year = int(request.args.get("year") or ist_now().year)
    except (TypeError, ValueError):
        year = ist_now().year

    docs = list(db.holidays.find({"date": {"$regex": f"^{year}-"}}).sort("date", 1))
    items = []
    for d in docs:
        paid = bool(d.get("paid", True))
        items.append({
            "name": str(d.get("name") or ""),
            "date": str(d.get("date") or ""),
            "type": "Company" if paid else "Optional",
        })
    return jsonify(items)


@app.post("/attendance/manual")
@admin_auth_required
@limiter.limit("120 per hour")
def add_manual_attendance():
    payload = request.get_json(silent=True) or {}
    employee_id = str(payload.get("employee_id") or "").strip()
    date_text = str(payload.get("date") or "").strip()
    check_in_raw = str(payload.get("check_in") or "").strip()
    check_out_raw = str(payload.get("check_out") or "").strip()
    reason = str(payload.get("reason") or "").strip()

    if not employee_id:
        return jsonify({"message": "Employee is required"}), 400
    if not date_text:
        return jsonify({"message": "Date is required"}), 400
    if not check_in_raw:
        return jsonify({"message": "Check-in time is required"}), 400
    if not reason:
        return jsonify({"message": "Reason is required"}), 400

    try:
        date_value = datetime.strptime(date_text, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        return jsonify({"message": "Invalid date format. Use YYYY-MM-DD."}), 400

    def _normalize_hms(value: str) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        for fmt in ("%H:%M:%S", "%H:%M"):
            try:
                dt = datetime.strptime(text, fmt)
                return dt.strftime("%H:%M:%S")
            except ValueError:
                continue
        raise ValueError("invalid_time")

    try:
        check_in_hms = _normalize_hms(check_in_raw)
        check_out_hms = _normalize_hms(check_out_raw) if check_out_raw else ""
    except ValueError:
        return jsonify({"message": "Invalid time format. Use HH:MM or HH:MM:SS."}), 400

    if check_out_hms and check_out_hms < check_in_hms:
        return jsonify({"message": "Check-out time cannot be earlier than check-in time for the selected date."}), 400

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        employee_oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    employee = db.employees.find_one({"_id": employee_oid})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    existing = db.attendance.find_one({"employee_id": employee_oid, "date": date_value})
    if existing:
        return jsonify({"message": "Attendance already exists for this employee on selected date"}), 409

    ist_tz = ist_now().tzinfo
    check_in_ist = datetime.strptime(f"{date_value} {check_in_hms}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=ist_tz)
    check_in_at = check_in_ist.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    check_out_at = None
    if check_out_hms:
        check_out_ist = datetime.strptime(f"{date_value} {check_out_hms}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=ist_tz)
        check_out_at = check_out_ist.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    policy_id_used = None
    policy_version_used = None
    policy_rule = {
        "status": "absent",
        "isLate": False,
        "workingHours": 0.0,
        "overtimeHours": 0.0,
    }
    policy_scope = "fallback"

    try:
        with get_policy_session() as policy_session:
            resolved = resolve_policy_for_employee(
                policy_session,
                employee_id=str(employee.get("_id")),
                department=str(employee.get("department") or ""),
                role=str(employee.get("role") or ""),
                on_date=datetime.strptime(date_value, "%Y-%m-%d").date(),
            )
            if resolved:
                policy_scope = resolved.resolved_by
                policy_id_used = resolved.policy.id
                policy_version_used = resolved.policy.version
                policy_rule = calculate_attendance(resolved.policy, check_in_ist, check_out_ist if check_out_hms else None)
    except Exception:
        logger.exception("policy_engine_manual_attendance_failed")

    entry_status = "Late" if bool(policy_rule.get("isLate")) else "On Time"
    exit_status = None
    timing_status = entry_status
    if check_out_hms:
        exit_status = "On Time Exit" if str(policy_rule.get("status") or "") == "present" else "Left Early"
        timing_status = exit_status

    now = datetime.now(timezone.utc)
    doc = {
        "employee_id": employee_oid,
        "employee_name": employee.get("name") or "",
        "date": date_value,
        "status": str(policy_rule.get("status") or "absent"),
        "attendance_status": str(policy_rule.get("status") or "absent"),
        "is_late": bool(policy_rule.get("isLate")),
        "working_hours": float(policy_rule.get("workingHours") or 0.0),
        "overtime_hours": float(policy_rule.get("overtimeHours") or 0.0),
        "policy_id": policy_id_used,
        "policy_version": policy_version_used,
        "policy_scope": policy_scope,
        "entry_status": entry_status,
        "exit_status": exit_status,
        "timing_status": timing_status,
        "check_in": check_in_hms,
        "check_in_at": check_in_at,
        "check_out": check_out_hms or None,
        "check_out_at": check_out_at,
        "entry_mode": "manual_admin",
        "exit_mode": "manual_admin" if check_out_hms else None,
        "manual_entry": True,
        "manual_reason": reason,
        "manual_marked_by": str(getattr(g, "admin_claims", {}).get("username") or "admin"),
        "created_at": now,
        "updated_at": now,
    }

    inserted = db.attendance.insert_one(doc)
    persist_mock_db_now()
    row = db.attendance.find_one({"_id": inserted.inserted_id})
    row = normalize_attendance_row_times(row) or {}
    row["id"] = str(row.pop("_id"))
    row["employee_id"] = str(row.get("employee_id"))
    row["status"] = "checked_out" if row.get("check_out") else "checked_in"
    row["timing_status"] = row.get("timing_status") or row.get("exit_status") or row.get("entry_status")
    row["manual_entry"] = bool(row.get("manual_entry"))
    row.pop("created_at", None)
    row.pop("updated_at", None)

    log_audit(
        "admin_manual_attendance_added",
        target={"employee_id": employee_id, "employee_name": employee.get("name")},
        details={"date": date_value, "check_in": check_in_hms, "check_out": check_out_hms or None, "reason": reason},
    )

    summary = _dashboard_summary_for_date(date_value)
    create_notification(
        f"Attendance marked manually for {employee.get('name') or 'employee'} on {date_value}",
        "attendance",
        employee_id,
    )
    return jsonify({"message": "Manual attendance added", "attendance": row, "dashboard": summary}), 201


def _employee_list_payload_from_query() -> dict:
    search = str(request.args.get("search", "")).strip().lower()
    department = str(request.args.get("department", "")).strip()
    role = str(request.args.get("role", "")).strip().lower()
    status = str(request.args.get("status", "")).strip().lower()
    company_id = str(request.args.get("company_id", "")).strip()

    try:
        page = max(1, int(request.args.get("page", "1")))
    except (TypeError, ValueError):
        page = 1
    try:
        per_page = max(1, min(100, int(request.args.get("per_page", "10"))))
    except (TypeError, ValueError):
        per_page = 10

    rows = attendance_manager.list_employees()

    filtered = []
    for row in rows:
        item = _serialize_employee_doc(row)

        # Company filter — must match company record (id / name / companyCode)
        if company_id:
            emp_company = str(item.get("company_name") or "").strip()
            emp_company_id = str(item.get("company_id") or "").strip()
            if not employee_doc_matches_company(db, company_id, emp_company, emp_company_id):
                continue

        if department and str(item.get("department") or "").strip().lower() != department.lower():
            continue
        if role and str(item.get("role") or "").strip().lower() != role:
            continue
        if status and str(item.get("status") or "").strip().lower() != status:
            continue

        if search:
            hay = " ".join(
                [
                    str(item.get("name") or ""),
                    str(item.get("email") or ""),
                    str(item.get("login_id") or ""),
                    str(item.get("department") or ""),
                    str(item.get("role") or ""),
                    str(item.get("company_name") or ""),
                ]
            ).lower()
            if search not in hay:
                continue

        filtered.append(item)

    total = len(filtered)
    start = (page - 1) * per_page
    items = filtered[start:start + per_page]

    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": max(1, math.ceil(total / per_page)) if per_page else 1,
    }


def _sync_employee_references(employee_oid, employee_doc: dict):
    employee_name = str((employee_doc or {}).get("name") or "").strip()
    if employee_oid is None or not employee_name:
        return

    db.attendance.update_many(
        {"employee_id": employee_oid},
        {"$set": {"employee_name": employee_name, "updated_at": datetime.now(timezone.utc)}},
    )
    db.manual_requests.update_many(
        {"employee_id": employee_oid},
        {"$set": {"employee_name": employee_name, "updated_at": datetime.now(timezone.utc)}},
    )
    db.leave_requests.update_many(
        {"employee_id": employee_oid},
        {"$set": {"employee_name": employee_name, "updated_at": datetime.now(timezone.utc)}},
    )
    db.tasks.update_many(
        {"assigned_to": str(employee_oid)},
        {"$set": {"assigned_to_name": employee_name}},
    )


@app.get("/api/employees")
@admin_auth_required
def api_get_employees():
    return jsonify(_employee_list_payload_from_query())


@app.get("/api/employees/<employee_id>")
@admin_auth_required
def api_get_employee(employee_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    row = db.employees.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Employee not found"}), 404

    return jsonify({"employee": _serialize_employee_doc(row)})


@app.post("/api/employees")
@admin_auth_required
@limiter.limit("60 per hour")
def api_create_employee():
    payload = request.get_json(silent=True) or {}

    name_raw = str(payload.get("name") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    department = str(payload.get("department") or "General").strip() or "General"
    role = _normalize_role_name(payload.get("role"), fallback="staff")
    status = _normalize_employee_status(payload.get("status"), fallback="active")

    login_id = str(payload.get("login_id") or "").strip().lower()
    if not login_id:
        login_id = _derive_login_id_from_email(email)

    password = payload.get("password") or os.getenv("DEFAULT_EMPLOYEE_PASSWORD", "Welcome123")

    if not name_raw:
        return jsonify({"message": "Name is required"}), 400

    email_issue = _validate_email(email)
    if email_issue:
        return jsonify({"message": email_issue}), 400

    login_issue = _validate_login_id(login_id)
    if login_issue:
        return jsonify({"message": login_issue}), 400

    dept_issue = _validate_department(department)
    if dept_issue:
        return jsonify({"message": dept_issue}), 400

    password_issue = _validate_password_policy(password)
    if password_issue:
        return jsonify({"message": password_issue}), 400

    if db.employees.find_one({"login_id": login_id}):
        return jsonify({"message": "Login ID already exists"}), 409
    if db.employees.find_one({"email": email}):
        return jsonify({"message": "Email already exists"}), 409

    display_name = slugify_name(name_raw)
    now = datetime.now()
    is_active = status == "active"

    comp_in = payload.get("compensation") if isinstance(payload.get("compensation"), dict) else {}
    monthly_salary = max(
        0.0,
        float(
            comp_in.get("monthlyGrossSalary")
            if comp_in.get("monthlyGrossSalary") is not None
            else (
                payload.get("monthly_salary")
                if payload.get("monthly_salary") is not None
                else payload.get("monthlySalary")
            )
            or 0.0
        ),
    )
    work_policy_raw = payload.get("work_policy") or payload.get("workPolicy") or {}
    work_policy = work_policy_raw if isinstance(work_policy_raw, dict) else {}

    _st = str(comp_in.get("salaryType") or payload.get("salary_type") or "CTC_BASED").strip().upper()
    salary_type = _st if _st in ("IN_HAND", "CTC_BASED") else "CTC_BASED"
    try:
        _nt_raw = None
        if comp_in.get("netTargetMonthly") is not None:
            _nt_raw = comp_in.get("netTargetMonthly")
        elif payload.get("net_target_monthly") is not None:
            _nt_raw = payload.get("net_target_monthly")
        else:
            _nt_raw = payload.get("netTargetMonthly")
        net_target_monthly = max(0.0, float(_nt_raw or 0.0))
    except (TypeError, ValueError):
        net_target_monthly = 0.0

    portal_access = bool(payload.get("portal_access", True))
    send_invite_email = bool(payload.get("send_invite_email", False))

    def _str(k): return str(payload.get(k) or "").strip()

    doc = {
        "name": display_name,
        "email": email,
        "department": department,
        "role": role,
        "status": status,
        "is_active": is_active,
        "active": is_active,
        "login_id": login_id,
        "password_hash": build_password_hash(password),
        "must_change_password": True,
        "password_updated_by": "admin",
        "password_updated_at": now,
        "image_folder": "",
        "monthly_salary": monthly_salary,
        "work_policy": work_policy,
        "salary_type": salary_type,
        "net_target_monthly": net_target_monthly,
        # ── Extended profile fields ───────────────────────────────────────
        "designation":             _str("designation"),
        "father_name":             _str("father_name"),
        "dob":                     _str("dob"),
        "gender":                  _str("gender"),
        "blood_group":             _str("blood_group"),
        "marital_status":          _str("marital_status"),
        "mobile":                  _str("mobile"),
        "emergency_contact_name":  _str("emergency_contact_name"),
        "emergency_contact_phone": _str("emergency_contact_phone"),
        "permanent_address":       _str("permanent_address"),
        "emp_id":                  _str("emp_id"),
        "date_of_joining":         _str("date_of_joining"),
        "employment_type":         _str("employment_type") or "Full-time",
        "reporting_manager":       _str("reporting_manager"),
        "company_name":            _str("company_name"),
        "aadhaar_number":          _str("aadhaar_number"),
        "pan_number":              _str("pan_number").upper(),
        "bank_account_no":         _str("bank_account_no"),
        "bank_ifsc":               _str("bank_ifsc").upper(),
        "bank_name":               _str("bank_name"),
        "photo_url":               _str("photo_url"),
        "compensation": {
            "monthlyGrossSalary": monthly_salary,
            "salaryType": salary_type,
            "netTargetMonthly": net_target_monthly,
            "payrollBasis": str(comp_in.get("payrollBasis") or "MONTHLY_GROSS"),
            "currency": str(comp_in.get("currency") or "INR"),
        },
        "portal_access": portal_access,
        "send_invite_email": send_invite_email,
        "created_at": now,
        "updated_at": now,
    }
    seed_leave_q = _sanitize_leave_quotas_document(payload.get("leave_quotas"))
    if seed_leave_q:
        doc["leave_quotas"] = seed_leave_q

    try:
        inserted = db.employees.insert_one(doc)
    except DuplicateKeyError:
        return jsonify({"message": "Employee already exists"}), 409

    persist_mock_db_now()
    created = db.employees.find_one({"_id": inserted.inserted_id})
    log_audit("api_create_employee", target={"employee_id": str(inserted.inserted_id), "login_id": login_id})
    summary = _dashboard_summary_for_date()
    create_notification(
        f"Employee added: {display_name}",
        "employee",
    )
    return jsonify({"message": "Employee created", "employee": _serialize_employee_doc(created), "dashboard": summary}), 201


@app.put("/api/employees/<employee_id>")
@admin_auth_required
@limiter.limit("120 per hour")
def api_update_employee(employee_id):
    payload = request.get_json(silent=True) or {}

    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    current = db.employees.find_one({"_id": oid})
    if not current:
        return jsonify({"message": "Employee not found"}), 404

    updates = {}

    if "name" in payload:
        next_name = str(payload.get("name") or "").strip()
        if not next_name:
            return jsonify({"message": "Name is required"}), 400
        updates["name"] = slugify_name(next_name)

    if "email" in payload:
        email = str(payload.get("email") or "").strip().lower()
        email_issue = _validate_email(email)
        if email_issue:
            return jsonify({"message": email_issue}), 400
        conflict = db.employees.find_one({"email": email, "_id": {"$ne": oid}})
        if conflict:
            return jsonify({"message": "Email already exists"}), 409
        updates["email"] = email

    if "login_id" in payload:
        login_id = str(payload.get("login_id") or "").strip().lower()
        login_issue = _validate_login_id(login_id)
        if login_issue:
            return jsonify({"message": login_issue}), 400
        conflict = db.employees.find_one({"login_id": login_id, "_id": {"$ne": oid}})
        if conflict:
            return jsonify({"message": "Login ID already exists"}), 409
        updates["login_id"] = login_id

    if "department" in payload:
        department = str(payload.get("department") or "General").strip() or "General"
        dept_issue = _validate_department(department)
        if dept_issue:
            return jsonify({"message": dept_issue}), 400
        updates["department"] = department

    if "role" in payload:
        updates["role"] = _normalize_role_name(payload.get("role"), fallback="staff")

    if "status" in payload:
        next_status = _normalize_employee_status(payload.get("status"), fallback=current.get("status") or "active")
        updates["status"] = next_status
        updates["is_active"] = next_status == "active"
        updates["active"] = next_status == "active"

    if "password" in payload and str(payload.get("password") or ""):
        new_password = str(payload.get("password") or "")
        password_issue = _validate_password_policy(new_password)
        if password_issue:
            return jsonify({"message": password_issue}), 400
        updates["password_hash"] = build_password_hash(new_password)
        updates["must_change_password"] = True
        updates["password_updated_by"] = "admin"
        updates["password_updated_at"] = datetime.now()

    if "monthly_salary" in payload or "monthlySalary" in payload:
        updates["monthly_salary"] = max(0.0, float(payload.get("monthly_salary") or payload.get("monthlySalary") or 0.0))

    comp_up = payload.get("compensation") if isinstance(payload.get("compensation"), dict) else None
    if comp_up:
        if "monthlyGrossSalary" in comp_up:
            try:
                updates["monthly_salary"] = max(0.0, float(comp_up.get("monthlyGrossSalary") or 0.0))
            except (TypeError, ValueError):
                pass
        if "salaryType" in comp_up:
            st = str(comp_up.get("salaryType") or "CTC_BASED").strip().upper()
            if st in ("IN_HAND", "CTC_BASED"):
                updates["salary_type"] = st
        if "netTargetMonthly" in comp_up:
            try:
                updates["net_target_monthly"] = max(0.0, float(comp_up.get("netTargetMonthly") or 0.0))
            except (TypeError, ValueError):
                pass
        merged_salary = float(updates.get("monthly_salary", current.get("monthly_salary") or 0.0))
        merged_type = str(updates.get("salary_type", current.get("salary_type") or "CTC_BASED"))
        if merged_type not in ("IN_HAND", "CTC_BASED"):
            merged_type = "CTC_BASED"
        merged_nt = float(updates.get("net_target_monthly", current.get("net_target_monthly") or 0.0))
        updates["compensation"] = {
            "monthlyGrossSalary": merged_salary,
            "salaryType": merged_type,
            "netTargetMonthly": merged_nt,
            "payrollBasis": str(comp_up.get("payrollBasis") or "MONTHLY_GROSS"),
            "currency": str(comp_up.get("currency") or "INR"),
        }

    if "portal_access" in payload:
        updates["portal_access"] = bool(payload.get("portal_access"))
    if "send_invite_email" in payload:
        updates["send_invite_email"] = bool(payload.get("send_invite_email"))

    if "work_policy" in payload or "workPolicy" in payload:
        wp = payload.get("work_policy") or payload.get("workPolicy") or {}
        if isinstance(wp, dict):
            updates["work_policy"] = wp

    if "leave_quotas" in payload and isinstance(payload.get("leave_quotas"), dict):
        new_lq = _sanitize_leave_quotas_document(payload.get("leave_quotas"))
        if new_lq:
            prior = current.get("leave_quotas") if isinstance(current.get("leave_quotas"), dict) else {}
            merged_lq = {**prior, **new_lq}
            updates["leave_quotas"] = merged_lq

    # Dual salary type
    if "salary_type" in payload:
        st = str(payload.get("salary_type") or "CTC_BASED").strip().upper()
        if st not in ("IN_HAND", "CTC_BASED"):
            st = "CTC_BASED"
        updates["salary_type"] = st
    if "net_target_monthly" in payload or "netTargetMonthly" in payload:
        ntm = payload.get("net_target_monthly") or payload.get("netTargetMonthly") or 0
        try:
            updates["net_target_monthly"] = max(0.0, float(ntm))
        except (TypeError, ValueError):
            pass

    # ── Extended profile fields (simple string pass-through) ─────────────────
    _ext_str = [
        "designation", "father_name", "dob", "gender", "blood_group",
        "marital_status", "mobile", "emergency_contact_name",
        "emergency_contact_phone", "permanent_address", "emp_id",
        "date_of_joining", "employment_type", "reporting_manager",
        "company_name", "aadhaar_number", "bank_account_no", "bank_name",
        "photo_url",
    ]
    for f in _ext_str:
        if f in payload:
            updates[f] = str(payload[f] or "").strip()
    if "pan_number" in payload:
        updates["pan_number"] = str(payload["pan_number"] or "").strip().upper()
    if "bank_ifsc" in payload:
        updates["bank_ifsc"] = str(payload["bank_ifsc"] or "").strip().upper()

    if not updates:
        return jsonify({"message": "No updates provided"}), 400

    updates["updated_at"] = datetime.now()
    db.employees.update_one({"_id": oid}, {"$set": updates})
    merged_employee = dict(current)
    merged_employee.update(updates)
    _sync_employee_references(oid, merged_employee)
    persist_mock_db_now()
    row = db.employees.find_one({"_id": oid})
    log_audit("api_update_employee", target={"employee_id": employee_id, "login_id": row.get("login_id")})
    summary = _dashboard_summary_for_date()
    return jsonify({"message": "Employee updated", "employee": _serialize_employee_doc(row), "dashboard": summary})


# ── Companies endpoints (Multi-Company HRMS) ─────────────────────────────────

_DEFAULT_COMPANY_TEMPLATE = {
    "id": "",
    "name": "",
    "companyCode": "",
    "tagline": "",
    "color": "#6b7280",
    "logo": "",
    "email": "",
    "phone": "",
    "website": "",
    "gst": "",
    "pan": "",
    "address": "",
    "timezone": "Asia/Kolkata",
    "payrollSettings": {
        "payrollCycle": "monthly",
        "pfEnabled": True,
        "pfPercent": 12.0,
        "tdsEnabled": True,
        "esicEnabled": False,
        "esicPercent": 0.75,
        "salaryPayDate": "last",
        "includeWeekendsInPayroll": True,
        "includeHolidaysInPayroll": True,
        "payrollCalculationMode": "calendar_days",
        "monthlyPayrollRegistry": {},
    },
    "attendanceSettings": {
        "shiftStart": "09:00",
        "shiftEnd": "18:00",
        "graceMinutes": 15,
        "halfDayHours": 4,
        "workMode": "office",
    },
    "leavePolicy": {
        "casualLeave": 12,
        "sickLeave": 6,
        "earnedLeave": 15,
        "maternityLeave": 180,
        "paternityLeave": 15,
        "approvalRequired": True,
    },
    "geofence": {
        "lat": 0,
        "lng": 0,
        "radiusMeters": 200,
        "enabled": False,
    },
    "shiftTiming": {
        "default": {"start": "09:00", "end": "18:00"},
    },
    "holidays": [],
    "createdAt": "",
}

_DEFAULT_COMPANIES = [
    {"id": "PR",       "name": "PR Technologies", "companyCode": "PR",     "tagline": "Primary Company",              "color": "#7c3aed"},
    {"id": "CD_IT",    "name": "CD_IT",    "companyCode": "CDIT",   "tagline": "Information Technology",       "color": "#2563eb"},
    {"id": "CD-EV",    "name": "CD-EV",    "companyCode": "CDEV",   "tagline": "Electric Vehicles Division",   "color": "#16a34a"},
    {"id": "CD-Hydro", "name": "CD-Hydro", "companyCode": "CDHYD",  "tagline": "Hydro Energy Projects",        "color": "#0891b2"},
    {"id": "CD-Infra", "name": "CD-Infra", "companyCode": "CDINFRA","tagline": "Infrastructure & Construction","color": "#d97706"},
    {"id": "OTHER",    "name": "Other Companies", "companyCode": "OTHER",  "tagline": "Miscellaneous / cross-unit",   "color": "#64748b"},
]

def _build_company_doc(raw):
    """Merge raw dict with full company template to ensure all fields present."""
    doc = dict(_DEFAULT_COMPANY_TEMPLATE)
    doc.update({k: v for k, v in raw.items() if v not in (None, "")})
    if not doc.get("createdAt"):
        doc["createdAt"] = datetime.now().isoformat()
    return doc


def _ensure_default_company_catalog():
    """Seed empty collection; backfill missing default company ids (e.g. OTHER) for older DBs."""
    docs = list(db.companies.find({}, {"_id": 0}))
    existing_ids = {str(d.get("id") or "") for d in docs}
    if not existing_ids:
        seed = [_build_company_doc(c) for c in _DEFAULT_COMPANIES]
        db.companies.insert_many([dict(s) for s in seed])
        return
    existing_map = {str(d.get("id") or ""): d for d in docs}
    for raw in _DEFAULT_COMPANIES:
        rid = str(raw.get("id") or "")
        if not rid:
            continue
        if rid not in existing_ids:
            try:
                db.companies.insert_one(dict(_build_company_doc(raw)))
                existing_ids.add(rid)
            except DuplicateKeyError:
                pass
        else:
            existing = existing_map.get(rid, {})
            patch = {}
            for field in ("name", "companyCode", "tagline", "color"):
                if not existing.get(field) and raw.get(field):
                    patch[field] = raw[field]
            if patch:
                db.companies.update_one({"id": rid}, {"$set": patch})


def _seed_demo_workforce_if_mock_empty():
    """Add sample employees when using mongomock and the workforce collection is empty (local demos)."""
    if not using_mock_db:
        return
    env_flag = str(os.getenv("MOCK_SEED_DEMO_EMPLOYEES", "1")).strip().lower()
    if env_flag in {"0", "false", "no", "off"}:
        return
    try:
        if db.employees.count_documents({}) > 0:
            return
    except Exception:
        return

    _ensure_default_company_catalog()
    now = datetime.now()
    ph = build_password_hash(str(os.getenv("DEFAULT_EMPLOYEE_PASSWORD", "Welcome123")))

    def demo_row(display_name: str, email: str, login_id: str, department: str, comp_id: str, comp_name: str) -> dict:
        return {
            "name": slugify_name(display_name),
            "email": str(email).strip().lower(),
            "department": department,
            "role": "staff",
            "status": "active",
            "is_active": True,
            "active": True,
            "login_id": str(login_id).strip().lower(),
            "password_hash": ph,
            "must_change_password": True,
            "password_updated_by": "demo_seed",
            "password_updated_at": now,
            "image_folder": "",
            "monthly_salary": 45000.0,
            "work_policy": {},
            "salary_type": "CTC_BASED",
            "net_target_monthly": 0.0,
            "company_id": comp_id,
            "company_name": comp_name,
            "employment_type": "Full-time",
            "designation": "",
            "compensation": {
                "monthlyGrossSalary": 45000.0,
                "salaryType": "CTC_BASED",
                "netTargetMonthly": 0.0,
                "payrollBasis": "MONTHLY_GROSS",
                "currency": "INR",
            },
            "portal_access": True,
            "send_invite_email": False,
            "created_at": now,
            "updated_at": now,
        }

    batch = [
        demo_row("Asha Verma", "asha.verma.demo@local.pr", "asha.verma", "Engineering", "PR", "PR Technologies"),
        demo_row("Rohan Mehta", "rohan.mehta.demo@local.pr", "rohan.mehta", "Sales", "PR", "PR Technologies"),
        demo_row("Priya Nair", "priya.nair.demo@local.pr", "priya.nair", "HR", "PR", "PR Technologies"),
        demo_row("Jamal Khan", "jamal.khan.demo@local.cdit", "jamal.khan", "IT", "CD_IT", "CD_IT"),
        demo_row("Lee Wong", "lee.wong.demo@local.cdit", "lee.wong", "Operations", "CD_IT", "CD_IT"),
    ]
    try:
        db.employees.insert_many(batch)
        persist_mock_db_now()
    except Exception:
        app.logger.exception("demo workforce seed failed")


@app.get("/api/companies")
@admin_auth_required
@limiter.limit("600 per minute")
def api_get_companies():
    _ensure_default_company_catalog()
    docs = list(db.companies.find({}, {"_id": 0}))
    # Backfill missing fields from template for older docs
    enriched = []
    for doc in docs:
        merged = dict(_DEFAULT_COMPANY_TEMPLATE)
        merged.update({k: v for k, v in doc.items() if v not in (None,)})
        enriched.append(merged)
    return jsonify({"companies": enriched})


@app.get("/api/companies/<company_id>")
@admin_auth_required
@limiter.limit("600 per minute")
def api_get_company(company_id):
    _ensure_default_company_catalog()
    doc = db.companies.find_one({"id": company_id}, {"_id": 0})
    if not doc:
        doc = db.companies.find_one({"companyCode": company_id}, {"_id": 0})
    if not doc and company_id:
        doc = db.companies.find_one({"companyCode": company_id.upper()}, {"_id": 0})
    if not doc:
        return jsonify({"message": "Company not found"}), 404
    return jsonify({"company": doc})


@app.post("/api/companies")
@admin_auth_required
@limiter.limit("30 per hour")
def api_create_company():
    body = request.get_json(silent=True) or {}
    name = str(body.get("name") or "").strip()
    if not name:
        return jsonify({"message": "Company name is required"}), 400
    cid = str(body.get("id") or name).upper().replace(" ", "_")
    if db.companies.find_one({"id": cid}):
        return jsonify({"message": "Company already exists"}), 409
    raw = {
        "id": cid,
        "name": name,
        "companyCode": str(body.get("companyCode") or cid),
        "tagline": str(body.get("tagline") or ""),
        "color": str(body.get("color") or "#6b7280"),
        "logo": str(body.get("logo") or ""),
        "email": str(body.get("email") or ""),
        "phone": str(body.get("phone") or ""),
        "website": str(body.get("website") or ""),
        "gst": str(body.get("gst") or ""),
        "pan": str(body.get("pan") or ""),
        "address": str(body.get("address") or ""),
    }
    if body.get("payrollSettings") and isinstance(body["payrollSettings"], dict):
        raw["payrollSettings"] = body["payrollSettings"]
    if body.get("attendanceSettings") and isinstance(body["attendanceSettings"], dict):
        raw["attendanceSettings"] = body["attendanceSettings"]
    if body.get("leavePolicy") and isinstance(body["leavePolicy"], dict):
        raw["leavePolicy"] = body["leavePolicy"]
    if body.get("geofence") and isinstance(body["geofence"], dict):
        raw["geofence"] = body["geofence"]
    if body.get("shiftTiming") and isinstance(body["shiftTiming"], dict):
        raw["shiftTiming"] = body["shiftTiming"]
    if body.get("holidays") and isinstance(body["holidays"], list):
        raw["holidays"] = body["holidays"]
    doc = _build_company_doc(raw)
    db.companies.insert_one(doc)
    return jsonify({"message": "Company created", "company": {k: v for k, v in doc.items() if k != "_id"}}), 201


@app.put("/api/companies/<company_id>")
@admin_auth_required
@limiter.limit("60 per hour")
def api_update_company(company_id):
    _ensure_default_company_catalog()
    existing = db.companies.find_one({"id": company_id})
    if not existing:
        return jsonify({"message": "Company not found"}), 404
    body = request.get_json(silent=True) or {}
    updates = {}
    _str_fields = ["name", "companyCode", "tagline", "color", "logo", "email", "phone", "website", "gst", "pan", "address", "timezone"]
    for f in _str_fields:
        if f in body:
            updates[f] = str(body[f] or "").strip()
    _obj_fields = ["payrollSettings", "attendanceSettings", "leavePolicy", "geofence", "shiftTiming"]
    for f in _obj_fields:
        if f in body and isinstance(body[f], dict):
            updates[f] = body[f]
    if "holidays" in body and isinstance(body["holidays"], list):
        updates["holidays"] = body["holidays"]
    if not updates:
        return jsonify({"message": "No updates provided"}), 400
    updates["updatedAt"] = datetime.now().isoformat()
    db.companies.update_one({"id": company_id}, {"$set": updates})
    merged = db.companies.find_one({"id": company_id}, {"_id": 0})
    return jsonify({"message": "Company updated", "company": merged})


@app.delete("/api/companies/<company_id>")
@admin_auth_required
@limiter.limit("10 per hour")
def api_delete_company(company_id):
    _ensure_default_company_catalog()
    existing = db.companies.find_one({"id": company_id})
    if not existing:
        return jsonify({"message": "Company not found"}), 404
    emp_count = db.employees.count_documents({"company_name": {"$regex": f"^{company_id}$", "$options": "i"}})
    if emp_count > 0:
        return jsonify({"message": f"Cannot delete company with {emp_count} employee(s). Reassign them first."}), 400
    db.companies.delete_one({"id": company_id})
    return jsonify({"message": "Company deleted"})


@app.get("/api/companies/<company_id>/employees")
@admin_auth_required
@limiter.limit("600 per minute")
def api_get_company_employees(company_id):
    """Employees for one company only (strict isolation)."""
    query = employees_match_query_for_company(db, company_id)
    docs = list(db.employees.find(query).sort("name", 1))
    return jsonify({"employees": [_serialize_employee_doc(d) for d in docs], "total": len(docs)})


@app.get("/api/companies/<company_id>/attendance")
@admin_auth_required
@limiter.limit("600 per minute")
def api_get_company_attendance(company_id):
    """Today's attendance for one company's employees only."""
    date_str = request.args.get("date", datetime.now().strftime("%Y-%m-%d"))
    emp_ids = [str(d["_id"]) for d in db.employees.find(employees_match_query_for_company(db, company_id), {"_id": 1})]
    if not emp_ids:
        return jsonify([])
    from bson import ObjectId as _OID
    oid_list = []
    for eid in emp_ids:
        try:
            oid_list.append(_OID(eid))
        except Exception:
            pass
    query = {
        "employee_id": {"$in": oid_list + emp_ids},
        "date": date_str,
    }
    records = list(db.attendance.find(query))
    result = []
    for r in records:
        r["_id"] = str(r["_id"])
        if "employee_id" in r:
            r["employee_id"] = str(r["employee_id"])
        result.append(r)
    return jsonify(result)


@app.get("/api/companies/<company_id>/dashboard")
@admin_auth_required
@limiter.limit("600 per minute")
def api_company_dashboard(company_id):
    """Company-scoped dashboard analytics."""
    query = employees_match_query_for_company(db, company_id)
    total_employees = db.employees.count_documents(query)
    emp_ids = [str(d["_id"]) for d in db.employees.find(query, {"_id": 1})]
    today = datetime.now().strftime("%Y-%m-%d")
    from bson import ObjectId as _OID
    oid_list = []
    for eid in emp_ids:
        try:
            oid_list.append(_OID(eid))
        except Exception:
            pass
    present_today = db.attendance.count_documents({
        "employee_id": {"$in": oid_list + emp_ids},
        "date": today,
        "status": {"$in": ["checked_in", "checked_out", "present", "Present", "PRESENT", "On Time Exit", "Late", "Left Early"]},
    }) if emp_ids else 0
    return jsonify({
        "companyId": company_id,
        "totalEmployees": total_employees,
        "presentToday": present_today,
        "absentToday": max(0, total_employees - present_today),
        "date": today,
    })


@app.delete("/api/employees/<employee_id>")
@admin_auth_required
@limiter.limit("60 per hour")
def api_delete_employee(employee_id):
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

    db.manual_requests.delete_many({"employee_id": oid})
    db.leave_requests.delete_many({"employee_id": oid})
    db.tasks.delete_many({"assigned_to": str(oid)})
    db.assets.delete_many({"employee_id": oid})

    employee_assets_dir = ASSETS_DIR / str(oid)
    if employee_assets_dir.exists():
        try:
            shutil.rmtree(employee_assets_dir, ignore_errors=True)
        except Exception:
            pass

    if image_folder:
        try:
            shutil.rmtree(image_folder, ignore_errors=True)
        except Exception:
            pass

    persist_mock_db_now()
    log_audit("api_delete_employee", target={"employee_id": employee_id, "employee_name": result.get("employee_name")})
    summary = _dashboard_summary_for_date()
    return jsonify({"message": "Employee deleted", "employee_name": result.get("employee_name"), "dashboard": summary})


# ─── Employee Salary Structure ────────────────────────────────────────────────

_DEFAULT_SALARY_STRUCTURE = {
    # ── v2 canonical fields (real Indian payslip – CCA structure) ──────────
    # All earnings are manually set; total must equal exactly 100%
    "basicPct":           50.0,
    "hraPct":             25.0,
    "conveyancePct":       5.0,
    "ccaPct":             18.75,  # City Compensatory Allowance – fully editable
    "medicalPct":          1.25,
    "positionAllowPct":    0.0,
    "newsPaperPct":        0.0,
    "mobileReimbPct":      0.0,
    "arrearPct":           0.0,
    # 50+25+5+18.75+1.25 = 100% by default ✓
    # Deductions
    "pfPct":               0.0,   # % of Basic  (e.g. 12)
    "tdsPct":              0.0,   # % of Gross Earnings (e.g. 10)
    "advanceAmount":       0.0,
    "otherDeductionAmt":   0.0,
    # Legacy
    "tdsAmount":           0.0,
    # Attendance template
    "totalDays":          30,
    "sundays":             4,
    "paidHolidays":        1,
    "presentDays":        25,
    "casualLeave":         0,
    "sickLeave":           0,
    # ── Legacy v1 fields (backward compat only) ───────────────────────────
    "basicPercent":       50.0,
    "hraPercent":         25.0,
    "allowancePercent":   15.0,
    "bonusPercent":        0.0,
    "pfPercent":           0.0,
    "taxPercent":          0.0,
    "otherDeductionPct":   0.0,
    "manualBonus":         0.0,
    "manualIncentive":     0.0,
    "manualPenalty":       0.0,
    "manualDeduction":     0.0,
}


def _get_salary_structure(employee_id: str) -> dict:
    """Return merged salary structure (DB overrides defaults).
    Handles both v2 canonical fields and legacy v1 field names.
    """
    doc = db.salary_structures.find_one({"employeeId": employee_id}) or {}
    merged = dict(_DEFAULT_SALARY_STRUCTURE)

    # Apply stored values for all known keys
    for k in list(merged.keys()):
        if k in doc:
            try:
                raw = doc[k]
                # Attendance int fields kept as int
                if k in ("totalDays", "sundays", "paidHolidays", "presentDays",
                         "casualLeave", "sickLeave"):
                    merged[k] = int(raw)
                else:
                    merged[k] = float(raw)
            except (TypeError, ValueError):
                pass

    # Also copy any unknown keys from DB doc (future-proof)
    for k, v in doc.items():
        if k not in ("_id", "employeeId", "updatedAt") and k not in merged:
            merged[k] = v

    # Back-fill v2 from v1 when v2 fields are still at their factory defaults
    # (only copy if the v1 field was actually customised away from ITS factory default)
    if merged.get("basicPct", 50.0) == 50.0 and merged.get("basicPercent", 50.0) != 50.0:
        merged["basicPct"] = merged["basicPercent"]
    if merged.get("hraPct", 25.0) == 25.0 and merged.get("hraPercent", 25.0) not in (20.0, 25.0):
        merged["hraPct"] = merged["hraPercent"]
    if merged.get("pfPct", 0.0) == 0.0 and merged.get("pfPercent", 0.0) != 0.0:
        merged["pfPct"] = merged["pfPercent"]

    return merged


def _gross_up_engine(net_target: float, basic_pct: float, pf_pct: float, tax_pct: float,
                      other_ded_pct: float, pt: float, max_iter: int = 20) -> dict:
    """
    Iterative gross-up: find Gross so that (Gross - all deductions) == net_target.
    Returns computed values and convergence metadata.
    PF is on min(Basic, 15000); Tax/Other are on Gross; PT is a fixed slab amount.
    """
    TOLERANCE = 1.0
    gross = net_target
    for i in range(1, max_iter + 1):
        basic = gross * (basic_pct / 100.0)
        pf    = round(min(basic, 15000.0) * (pf_pct / 100.0), 2)
        tax   = round(gross * (tax_pct / 100.0), 2)
        oth   = round(gross * (other_ded_pct / 100.0), 2)
        total_deductions = pf + tax + oth + pt
        required = net_target + total_deductions
        if abs(required - gross) < TOLERANCE:
            return {
                "gross": round(required, 0),
                "basic": round(required * (basic_pct / 100.0), 0),
                "pf": pf, "tax": tax, "other": oth, "pt": pt,
                "totalDeductions": round(total_deductions, 0),
                "dra": round(total_deductions, 0),
                "iterations": i, "converged": True,
            }
        gross = required
    return {
        "gross": round(gross, 0),
        "basic": round(gross * (basic_pct / 100.0), 0),
        "pf": pf, "tax": tax, "other": oth, "pt": pt,
        "totalDeductions": round(pf + tax + oth + pt, 0),
        "dra": round(pf + tax + oth + pt, 0),
        "iterations": max_iter, "converged": False,
    }


def _compute_payroll_preview(employee: dict, structure: dict, year: int, month: int) -> dict:
    """
    Full payroll calculation.
    Branches on salary_type:
      IN_HAND  → gross-up engine: net_target is guaranteed bank credit
      CTC_BASED → standard forward calculation
    """
    today = _today_ist_date()
    salary_type = str(employee.get("salary_type") or "CTC_BASED").upper()
    monthly_salary = float(employee.get("monthly_salary") or 0.0)
    # ════════════════════════════════════════════
    # TYPE A — IN_HAND (Gross-Up) PATH
    # ════════════════════════════════════════════
    if salary_type == "IN_HAND":
        net_target = float(employee.get("net_target_monthly") or monthly_salary or 0.0)
        if not net_target:
            net_target = monthly_salary

        # Attendance-based proration of the net target
        from datetime import date as _date
        import calendar as _cal
        _, _days_in_month = _cal.monthrange(year, month)
        _sundays = sum(1 for d in range(1, _days_in_month + 1) if _date(year, month, d).weekday() == 6)
        _saturdays = sum(1 for d in range(1, _days_in_month + 1) if _date(year, month, d).weekday() == 5)
        prorate = 1.0
        present_days = 0
        working_days_slot = 25
        absent_count = 0
        half_day_count = 0
        paid_days = 0.0
        weekoff_days = 0
        holiday_days = 0
        paid_leave_days = 0
        casual_leave_days = 0
        sick_leave_days = 0
        unpaid_leave_days = 0
        lop_days = 0.0
        late_marks = 0
        early_exits = 0
        overtime_hours = 0.0
        overtime_amt = 0.0
        status_breakdown: dict = {}
        attendance_record_count = 0
        leave_record_count = 0
        holiday_record_count = 0
        attendance_last_synced_at = ""
        attendance_source_message = ""
        elapsed_cal = 0
        attendance_pct_eff = 0.0
        if _payroll_ok():
            up_to_day = today.day if (year == today.year and month == today.month) else None
            smry = _payroll_calculator.get_month_summary(employee, year, month, up_to_day)
            full_cal = int(smry.get("calendarDaysInFullMonth") or _days_in_month)
            _days_in_month = full_cal
            working_days_slot = int(smry.get("workingDaysInMonth") or 0) or 25
            elapsed_cal = int(smry.get("elapsedCalendarDays") or smry.get("daysTracked") or 0)
            _sundays = smry.get("sundaysInMonth", _sundays) or _sundays
            _saturdays = smry.get("saturdaysInMonth", _saturdays) or _saturdays
            present_days  = smry.get("presentDays", 0)
            overtime_amt  = float(smry.get("totalOvertime") or 0.0)
            overtime_hours = float(smry.get("totalOvertimeHours") or 0.0)
            status_breakdown = smry.get("statusBreakdown", {})
            absent_count  = smry.get("absentDays", 0) or status_breakdown.get("absent", 0)
            half_day_count = smry.get("halfDays", 0) or status_breakdown.get("half_day", 0)
            paid_days = float(smry.get("paidDays", 0.0) or 0.0)
            weekoff_days = smry.get("weekoffDays", 0) or 0
            holiday_days = smry.get("holidayDays", 0) or 0
            paid_leave_days = smry.get("paidLeaveDays", 0) or 0
            casual_leave_days = smry.get("casualLeaveDays", 0) or 0
            sick_leave_days = smry.get("sickLeaveDays", 0) or 0
            unpaid_leave_days = smry.get("unpaidLeaveDays", 0) or 0
            lop_days = float(smry.get("lopDays", 0.0) or 0.0)
            late_marks = smry.get("lateMarks", 0) or 0
            early_exits = smry.get("earlyExits", 0) or 0
            attendance_record_count = int(smry.get("attendanceRecordCount") or 0)
            leave_record_count = int(smry.get("approvedLeaveRecordCount") or 0)
            holiday_record_count = int(smry.get("holidayRecordCount") or 0)
            attendance_last_synced_at = str(smry.get("lastSyncedAt") or "")
            attendance_source_message = str(smry.get("sourceMessage") or "")
            attendance_pct_eff = float(smry.get("attendancePercentage") or 0.0)
            earned_mtd = float(smry.get("earnedTillNow") or 0.0)
            if net_target > 0:
                prorate = max(0.0, min(1.0, earned_mtd / net_target))
            else:
                prorate = 0.0
        else:
            full_cal = int(_days_in_month)
            working_days_slot = max(1, full_cal - 8)
            elapsed_cal = full_cal
            attendance_pct_eff = 0.0

        prorated_net = round(net_target * prorate, 2)
        daily_rate_calendar = round(net_target / max(1, int(_days_in_month)), 2)
        pt_slab = float(structure.get("ptSlab") or 200.0)

        gu = _gross_up_engine(
            net_target=prorated_net,
            basic_pct=float(structure.get("basicPercent") or 40.0),
            pf_pct=float(structure.get("pfPercent") or 12.0),
            tax_pct=float(structure.get("taxPercent") or 5.0),
            other_ded_pct=float(structure.get("otherDeductionPct") or 0.0),
            pt=pt_slab,
        )

        gross = gu["gross"]
        basic = gu["basic"]
        hra   = round(gross * (float(structure.get("hraPercent") or 20.0) / 100.0), 0)
        dra   = gu["dra"]

        # Remaining special allowance fills the gross
        earnings_so_far = basic + hra + dra
        special = max(0.0, gross - earnings_so_far)

        earn_pct_total = (
            float(structure.get("basicPercent") or 40) +
            float(structure.get("hraPercent") or 20)
        )

        return {
            "salaryType": "IN_HAND",
            "netTarget": net_target,
            "proratedNet": prorated_net,
            "monthlySalary": net_target,
            "earnedSalary": prorated_net,
            "workingDaysInMonth": working_days_slot,
            "totalDaysInMonth": int(_days_in_month),
            "calendarDaysInFullMonth": int(_days_in_month),
            "elapsedCalendarDays": elapsed_cal,
            "daysTracked": elapsed_cal,
            "sundaysInMonth": _sundays,
            "saturdaysInMonth": _saturdays,
            "presentDays": present_days,
            "absentDays": absent_count,
            "lopDays": round(lop_days, 1),
            "halfDayCount": half_day_count,
            "halfDays": half_day_count,
            "paidDays": round(paid_days, 1),
            "weekoffDays": weekoff_days,
            "holidayDays": holiday_days,
            "paidHolidayDays": holiday_days,
            "casualLeaveDays": casual_leave_days,
            "sickLeaveDays": sick_leave_days,
            "paidLeaveDays": paid_leave_days,
            "unpaidLeaveDays": unpaid_leave_days,
            "dailyRate": daily_rate_calendar,
            "lateMarks": late_marks,
            "earlyExits": early_exits,
            "overtimeHours": round(overtime_hours, 2),
            "overtimeEarnings": round(overtime_amt, 2),
            "attendanceSource": "database" if _payroll_ok() else "unavailable",
            "attendanceRecordCount": attendance_record_count,
            "approvedLeaveRecordCount": leave_record_count,
            "leaveRecordCount": leave_record_count,
            "holidayRecordCount": holiday_record_count,
            "attendanceLastSyncedAt": attendance_last_synced_at,
            "attendanceSourceMessage": attendance_source_message,
            "grossUpResult": gu,
            "earnings": {
                "basic": basic,
                "hra": hra,
                "special": special,
                "dra": dra,
                "manualBonus": float(structure.get("manualBonus") or 0),
                "manualIncentive": float(structure.get("manualIncentive") or 0),
            },
            "grossSalary": gross,
            "deductions": {
                "pf": gu["pf"],
                "tax": gu["tax"],
                "otherDeduction": gu.get("other", 0),
                "pt": gu["pt"],
                "manualPenalty": float(structure.get("manualPenalty") or 0),
                "manualDeduction": float(structure.get("manualDeduction") or 0),
            },
            "totalDeductions": gu["totalDeductions"],
            "netSalary": prorated_net,
            "attendancePct": attendance_pct_eff if _payroll_ok() else 0.0,
            "statusBreakdown": status_breakdown,
            "structure": structure,
            "warnings": [] if gu["converged"] else ["Gross-up did not converge — flagged for review"],
            "year": year,
            "month": month,
        }

    # ════════════════════════════════════════════
    # TYPE B — CTC_BASED (Standard Forward) PATH
    # ════════════════════════════════════════════

    # ── Attendance-based earned salary (calendar divisor; MTD earned from engine) ──
    earned_salary = 0.0
    present_days  = 0
    working_days  = 1
    overtime_amt  = 0.0
    half_day_count = 0
    absent_count   = 0
    paid_days = 0.0
    weekoff_days = 0
    holiday_days = 0
    paid_leave_days = 0
    casual_leave_days = 0
    sick_leave_days = 0
    unpaid_leave_days = 0
    lop_days = 0.0
    absent_deduction = 0.0
    half_day_deduction = 0.0
    late_penalty = 0.0
    late_marks = 0
    early_exits = 0
    status_breakdown: dict = {}
    daily_rate = 0.0
    full_calendar_days = 0
    elapsed_calendar_days = 0
    days_tracked = 0
    sundays_in_month = 0
    saturdays_in_month = 0
    attendance_source = "database" if _payroll_ok() else "unavailable"
    attendance_record_count = 0
    leave_record_count = 0
    holiday_record_count = 0
    attendance_last_synced_at = ""
    attendance_source_message = ""
    attendance_pct_v = 0.0
    summary = {}

    # Always fetch real attendance from DB regardless of salary amount
    if _payroll_ok():
        up_to_day = today.day if (year == today.year and month == today.month) else None
        summary = _payroll_calculator.get_month_summary(employee, year, month, up_to_day)
        full_calendar_days = int(summary.get("calendarDaysInFullMonth") or 0)
        elapsed_calendar_days = int(summary.get("elapsedCalendarDays") or summary.get("totalDaysInMonth") or 0)
        days_tracked = int(summary.get("daysTracked") or 0)
        working_days      = int(summary.get("workingDaysInMonth", 0) or 1) or 1
        sundays_in_month = summary.get("sundaysInMonth", 0) or 0
        saturdays_in_month = summary.get("saturdaysInMonth", 0) or 0
        present_days      = summary.get("presentDays", 0)
        overtime_amt      = float(summary.get("totalOvertime") or 0.0)
        status_breakdown  = summary.get("statusBreakdown", {})
        half_day_count    = summary.get("halfDays", 0) or status_breakdown.get("half_day", 0)
        absent_count      = summary.get("absentDays", 0) or status_breakdown.get("absent", 0)
        paid_days         = float(summary.get("paidDays", 0.0) or 0.0)
        weekoff_days      = summary.get("weekoffDays", 0) or 0
        holiday_days      = summary.get("holidayDays", 0) or 0
        paid_leave_days   = summary.get("paidLeaveDays", 0) or 0
        casual_leave_days = summary.get("casualLeaveDays", 0) or 0
        sick_leave_days   = summary.get("sickLeaveDays", 0) or 0
        unpaid_leave_days = summary.get("unpaidLeaveDays", 0) or 0
        lop_days          = float(summary.get("lopDays", 0.0) or 0.0)
        absent_deduction  = float(summary.get("absentDeduction") or 0.0)
        half_day_deduction = float(summary.get("halfDayDeduction") or 0.0)
        late_penalty      = float(summary.get("latePenalty") or 0.0)
        late_marks        = summary.get("lateMarks", 0) or 0
        early_exits       = summary.get("earlyExits", 0) or 0
        attendance_record_count = int(summary.get("attendanceRecordCount") or 0)
        leave_record_count = int(summary.get("approvedLeaveRecordCount") or 0)
        holiday_record_count = int(summary.get("holidayRecordCount") or 0)
        attendance_last_synced_at = str(summary.get("lastSyncedAt") or "")
        attendance_source_message = str(summary.get("sourceMessage") or "")
        attendance_pct_v = float(summary.get("attendancePercentage") or 0.0)
        import calendar as _crefa

        _, _cref_len = _crefa.monthrange(year, month)
        full_calendar_days = max(int(_cref_len), full_calendar_days)
        denom_cal = max(1, full_calendar_days)
        earned_salary = float(summary.get("earnedTillNow") or 0.0)
        daily_rate = monthly_salary / denom_cal if monthly_salary > 0 else 0.0
    else:
        # Payroll calculator unavailable — safe fallback (full month, no attendance carve-out)
        import calendar as _fallback_cal

        _, full_calendar_days = _fallback_cal.monthrange(year, month)
        full_calendar_days = int(full_calendar_days)
        elapsed_calendar_days = full_calendar_days
        days_tracked = full_calendar_days
        working_days = max(1, full_calendar_days - 8)
        earned_salary = monthly_salary if monthly_salary > 0 else 0.0
        daily_rate = monthly_salary / max(1, full_calendar_days) if monthly_salary > 0 else 0.0
        paid_days = float(full_calendar_days)
        attendance_pct_v = 100.0 if monthly_salary > 0 else 0.0

    earned_salary = max(0.0, round(float(earned_salary), 2))

    # ── Earnings breakdown (on attendance-earned MTD base) ──
    basic_pct      = float(structure.get("basicPct")       or structure.get("basicPercent")     or 50.0)
    hra_pct        = float(structure.get("hraPct")         or structure.get("hraPercent")        or 25.0)
    conveyance_pct = float(structure.get("conveyancePct")  or 0.0)
    cca_pct        = float(structure.get("ccaPct")        or 0.0)
    bonus_pct      = float(structure.get("bonusPct")       or structure.get("bonusPercent")      or 5.0)
    medical_pct    = float(structure.get("medicalPct")     or 0.0)
    other_earn_pct = float(structure.get("otherEarningsPct") or 0.0)
    # specialPct = 100 - sum of above (auto-balance, if all v2 fields are present)
    fixed_pct      = basic_pct + hra_pct + conveyance_pct + cca_pct + bonus_pct + medical_pct + other_earn_pct
    special_pct    = max(0.0, 100.0 - fixed_pct)
    pf_pct         = float(structure.get("pfPct")         or structure.get("pfPercent")          or 12.0)
    _raw_tds = structure.get("tdsAmount")
    if _raw_tds is not None and float(_raw_tds or 0) != 0:
        tds_amount = float(_raw_tds)
    else:
        _tds_pct = float(structure.get("tdsPct") or structure.get("taxPercent") or 0.0)
        tds_amount = _tds_pct * earned_salary / 100.0
    advance_amount = float(structure.get("advanceAmount")  or 0.0)
    other_ded_amt  = float(structure.get("otherDeductionAmt") or 0.0)

    basic      = round(earned_salary * basic_pct      / 100, 2)
    hra        = round(earned_salary * hra_pct        / 100, 2)
    conveyance = round(earned_salary * conveyance_pct / 100, 2)
    cca        = round(earned_salary * cca_pct       / 100, 2)
    special    = round(earned_salary * special_pct    / 100, 2)
    bonus      = round(earned_salary * bonus_pct      / 100, 2)
    medical    = round(earned_salary * medical_pct    / 100, 2)
    allowance  = conveyance  # v1 compat alias
    manual_bonus     = float(structure.get("manualBonus") or 0)
    manual_incentive = float(structure.get("manualIncentive") or 0)
    manual_penalty   = float(structure.get("manualPenalty") or 0)
    manual_deduction = float(structure.get("manualDeduction") or 0)

    gross = round(basic + hra + conveyance + cca + special + bonus + medical + manual_bonus + manual_incentive + overtime_amt, 2)

    # ── Deductions ──
    pf         = round(basic * pf_pct / 100, 2)
    tds        = round(tds_amount, 2)
    adv        = round(advance_amount, 2)
    other_ded  = round(other_ded_amt, 2)
    total_ded  = round(pf + tds + adv + other_ded + manual_penalty + manual_deduction, 2)
    # Legacy var for compat
    tax        = tds
    net_salary = round(gross - total_ded, 2)

    # ── Validation ──
    earning_pct_total = fixed_pct
    warnings = []
    if earning_pct_total > 100:
        warnings.append(f"Earning percentages sum to {earning_pct_total:.1f}% — exceeds 100%")

    # Compute Sundays and Saturdays for the full salary month + align calendar/elapsed helpers
    from datetime import date as _date
    import calendar as _cal
    today_d = _today_ist_date()
    is_mtd_view = year == today_d.year and month == today_d.month

    _, _days_in_month_meta = _cal.monthrange(year, month)
    full_calendar_days = max(full_calendar_days, int(_days_in_month_meta))

    if elapsed_calendar_days <= 0:
        elapsed_calendar_days = days_tracked or (min(today_d.day, full_calendar_days) if is_mtd_view else full_calendar_days)
    if days_tracked <= 0:
        days_tracked = elapsed_calendar_days

    _sundays_full = sum(1 for d in range(1, full_calendar_days + 1) if _date(year, month, d).weekday() == 6)
    _saturdays_full = sum(1 for d in range(1, full_calendar_days + 1) if _date(year, month, d).weekday() == 5)
    sundays_in_month = sundays_in_month or _sundays_full
    saturdays_in_month = saturdays_in_month or _saturdays_full

    synced_through_day = int(elapsed_calendar_days) if elapsed_calendar_days > 0 else full_calendar_days
    daily_rate_out = monthly_salary / max(1, full_calendar_days) if monthly_salary > 0 else 0.0
    return {
        "salaryType": "CTC_BASED",
        "monthlySalary": monthly_salary,
        "earnedSalary": round(earned_salary, 2),
        "isMonthToDate": is_mtd_view,
        "syncedThroughDay": synced_through_day,
        "workingDaysInMonth": working_days,
        "totalDaysInMonth": full_calendar_days,
        "calendarDaysInFullMonth": full_calendar_days,
        "elapsedCalendarDays": elapsed_calendar_days,
        "daysTracked": days_tracked,
        "sundaysInMonth": sundays_in_month,
        "saturdaysInMonth": saturdays_in_month,
        "presentDays": present_days,
        "absentDays": absent_count,
        "lopDays": round(lop_days, 1),
        "halfDayCount": half_day_count,
        "halfDays": half_day_count,
        "paidDays": round(paid_days, 1),
        "weekoffDays": weekoff_days,
        "holidayDays": holiday_days,
        "paidHolidayDays": holiday_days,
        "casualLeaveDays": casual_leave_days,
        "sickLeaveDays": sick_leave_days,
        "paidLeaveDays": paid_leave_days,
        "unpaidLeaveDays": unpaid_leave_days,
        "payableStatuses": ["present", "weekoff", "holiday", "paid_leave"],
        "absentDeduction": round(absent_deduction, 2),
        "halfDayDeduction": round(half_day_deduction, 2),
        "latePenalty": round(late_penalty, 2),
        "dailyRate": round(daily_rate_out, 2),
        "lateMarks": late_marks,
        "earlyExits": early_exits,
        "overtimeHours": round(float((summary or {}).get("totalOvertimeHours") or 0.0), 2) if _payroll_ok() else 0.0,
        "overtimeEarnings": round(overtime_amt, 2),
        "attendanceSource": attendance_source,
        "attendanceRecordCount": attendance_record_count,
        "approvedLeaveRecordCount": leave_record_count,
        "leaveRecordCount": leave_record_count,
        "holidayRecordCount": holiday_record_count,
        "attendanceLastSyncedAt": attendance_last_synced_at,
        "attendanceSourceMessage": attendance_source_message,
        "earnings": {
            "basic": basic,
            "hra": hra,
            "conveyance": conveyance,
            "special": special,
            "bonus": bonus,
            "medical": medical,
            "cca": cca,
            "allowance": allowance,   # legacy alias = conveyance
            "manualBonus": round(manual_bonus, 2),
            "manualIncentive": round(manual_incentive, 2),
        },
        "grossSalary": gross,
        "deductions": {
            "pf": pf,
            "tds": tds,
            "advance": adv,
            "otherDeduction": other_ded,
            "tax": tax,               # legacy alias = tds
            "manualPenalty": round(manual_penalty, 2),
            "manualDeduction": round(manual_deduction, 2),
        },
        "totalDeductions": total_ded,
        "netSalary": net_salary,
        "attendancePct": attendance_pct_v,
        "statusBreakdown": status_breakdown,
        "structure": structure,
        "warnings": warnings,
        "year": year,
        "month": month,
    }


@app.get("/api/employees/<employee_id>/salary-structure")
@admin_auth_required
@limiter.limit("120 per hour")
def api_get_salary_structure(employee_id):
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    emp = db.employees.find_one({"_id": oid})
    if not emp:
        return jsonify({"message": "Employee not found"}), 404

    structure = _get_salary_structure(employee_id)
    return jsonify({
        "employeeId": employee_id,
        "monthlySalary": float(emp.get("monthly_salary") or 0.0),
        "salaryType": str(emp.get("salary_type") or "CTC_BASED"),
        "netTargetMonthly": float(emp.get("net_target_monthly") or 0.0),
        "structure": structure,
    })


@app.put("/api/employees/<employee_id>/salary-structure")
@admin_auth_required
@limiter.limit("120 per hour")
def api_put_salary_structure(employee_id):
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    emp = db.employees.find_one({"_id": oid})
    if not emp:
        return jsonify({"message": "Employee not found"}), 404

    body = request.get_json(force=True, silent=True) or {}

    # v2 canonical float fields
    v2_float_fields = [
        "basicPct", "hraPct", "conveyancePct", "ccaPct", "medicalPct",
        "positionAllowPct", "newsPaperPct", "mobileReimbPct", "arrearPct",
        # legacy compat
        "bonusPct", "otherEarningsPct",
        "pfPct", "tdsPct", "tdsAmount", "advanceAmount", "otherDeductionAmt",
    ]
    # v2 attendance int fields
    v2_int_fields = [
        "totalDays", "sundays", "paidHolidays", "presentDays",
        "casualLeave", "sickLeave",
    ]
    # v1 legacy float fields
    v1_fields = [
        "basicPercent", "hraPercent", "allowancePercent", "bonusPercent",
        "pfPercent", "taxPercent", "otherDeductionPct",
        "manualBonus", "manualIncentive", "manualPenalty", "manualDeduction",
    ]

    update: dict = {"employeeId": employee_id, "updatedAt": datetime.utcnow()}
    for f in v2_float_fields + v1_fields:
        if f in body:
            try:
                update[f] = float(body[f])
            except (TypeError, ValueError):
                pass
    for f in v2_int_fields:
        if f in body:
            try:
                update[f] = int(body[f])
            except (TypeError, ValueError):
                pass

    _body_to_v2 = {
        "conveyancePercent": "conveyancePct",
        "ccaPercent": "ccaPct",
        "medicalPercent": "medicalPct",
        "otherAllowancePercent": "otherEarningsPct",
        "taxPercent": "tdsPct",
        "advanceDeduction": "advanceAmount",
    }
    for src, dst in _body_to_v2.items():
        if src in body:
            try:
                update[dst] = float(body[src])
            except (TypeError, ValueError):
                pass
    if "basicPercent" in body:
        try:
            update["basicPct"] = float(body["basicPercent"])
        except (TypeError, ValueError):
            pass
    if "hraPercent" in body:
        try:
            update["hraPct"] = float(body["hraPercent"])
        except (TypeError, ValueError):
            pass
    if "pfPercent" in body:
        try:
            update["pfPct"] = float(body["pfPercent"])
        except (TypeError, ValueError):
            pass

    # Update employee-level fields if provided (gross salary is owned by employee compensation — not from this endpoint)
    emp_updates = {}
    if "salary_type" in body:
        st = str(body["salary_type"]).strip().upper()
        if st in ("IN_HAND", "CTC_BASED"):
            emp_updates["salary_type"] = st
    if "net_target_monthly" in body:
        try:
            emp_updates["net_target_monthly"] = max(0.0, float(body["net_target_monthly"]))
        except (TypeError, ValueError):
            pass
    if emp_updates:
        db.employees.update_one({"_id": oid}, {"$set": emp_updates})

    db.salary_structures.update_one(
        {"employeeId": employee_id},
        {"$set": update},
        upsert=True,
    )
    merged = _get_salary_structure(employee_id)
    return jsonify({"message": "Salary structure saved", "structure": merged})


@app.route("/api/employees/<employee_id>/payroll-preview", methods=["GET", "POST"])
@admin_auth_required
@limiter.limit("120 per hour")
def api_payroll_preview(employee_id):
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    emp = db.employees.find_one({"_id": oid})
    if not emp:
        return jsonify({"message": "Employee not found"}), 404

    today = _today_ist_date()
    try:
        year  = int(request.args.get("year")  or today.year)
        month = int(request.args.get("month") or today.month)
    except (TypeError, ValueError):
        year, month = today.year, today.month

    # Optionally accept inline structure overrides for live preview
    body = request.get_json(force=True, silent=True) or {}
    structure = _get_salary_structure(employee_id)
    fields = [
        "basicPercent", "hraPercent", "allowancePercent", "bonusPercent",
        "pfPercent", "taxPercent", "otherDeductionPct",
        "manualBonus", "manualIncentive", "manualPenalty", "manualDeduction",
    ]
    for f in fields:
        if f in body:
            try:
                structure[f] = float(body[f])
            except (TypeError, ValueError):
                pass
    # Frontend/UI aliases → v2 canonical keys (live preview)
    _preview_aliases = {
        "conveyancePercent": "conveyancePct",
        "ccaPercent": "ccaPct",
        "medicalPercent": "medicalPct",
        "otherAllowancePercent": "otherEarningsPct",
    }
    for src, dst in _preview_aliases.items():
        if src in body:
            try:
                structure[dst] = float(body[src])
            except (TypeError, ValueError):
                pass
    if "basicPercent" in body:
        try:
            structure["basicPct"] = float(body["basicPercent"])
        except (TypeError, ValueError):
            pass
    if "hraPercent" in body:
        try:
            structure["hraPct"] = float(body["hraPercent"])
        except (TypeError, ValueError):
            pass
    if "pfPercent" in body:
        try:
            structure["pfPct"] = float(body["pfPercent"])
        except (TypeError, ValueError):
            pass
    if "taxPercent" in body:
        try:
            structure["tdsPct"] = float(body["taxPercent"])
        except (TypeError, ValueError):
            pass
    if "advanceDeduction" in body:
        try:
            structure["advanceAmount"] = float(body["advanceDeduction"])
        except (TypeError, ValueError):
            pass
    # Allow inline overrides for live preview
    emp = dict(emp)
    if "monthlySalary" in body:
        try:
            emp["monthly_salary"] = float(body["monthlySalary"])
        except (TypeError, ValueError):
            pass
    if "salary_type" in body:
        st = str(body["salary_type"]).strip().upper()
        if st in ("IN_HAND", "CTC_BASED"):
            emp["salary_type"] = st
    if "net_target_monthly" in body:
        try:
            emp["net_target_monthly"] = max(0.0, float(body["net_target_monthly"]))
        except (TypeError, ValueError):
            pass

    preview = _compute_payroll_preview(emp, structure, year, month)
    preview["employeeId"]   = employee_id
    preview["employeeName"] = str(emp.get("name") or "")
    preview["department"]   = str(emp.get("department") or "General")
    return jsonify(preview)


def _payslip_arrays_from_calculator_snapshot(snap: dict) -> Tuple[List, List]:
    """Map admin calculator snapshot (frontend computePayrollSnapshot) to payslip earnings/deductions arrays."""
    snap = snap or {}
    eg = snap.get("earnings") if isinstance(snap.get("earnings"), dict) else {}

    def r2(v) -> float:
        try:
            return round(float(v or 0), 2)
        except (TypeError, ValueError):
            return 0.0

    earn_specs = [
        ("BASIC", "Basic Salary", eg.get("basic")),
        ("HRA", "HRA", eg.get("hra")),
        ("CONV", "Conveyance Allowance", eg.get("conveyance")),
        ("CCA", "CCA", eg.get("cca")),
        ("MED", "Medical", eg.get("medical")),
        ("POS_ALW", "Position Allowance", eg.get("positionAllow")),
        ("NEWS", "New Paper and Periodicals", eg.get("newsPaper")),
        ("MOBILE", "Mobile Reimbursement", eg.get("mobileReimb")),
        ("ARREAR", "Arrear", eg.get("arrear")),
        ("OT", "Overtime Earnings", eg.get("overtime")),
        ("BONUS", "Bonus", eg.get("bonus")),
        ("OTHER_EARN", "Other Earnings", eg.get("otherEarnings")),
    ]
    earnings: List = []
    for code, name, raw in earn_specs:
        amt = r2(raw)
        if amt > 0:
            earnings.append({"code": code, "name": name, "amount": amt})

    deductions: List = []
    lop_amt = r2(snap.get("lopDed"))
    if lop_amt > 0:
        deductions.append({"code": "LOP", "name": "Loss of Pay (LOP)", "amount": lop_amt})

    # PF / TDS / advance always listed when present on slip (mirror PayslipDoc)
    pf_amt = r2(snap.get("pf"))
    tds_amt = r2(snap.get("tds"))
    adv_amt = r2(snap.get("advance"))
    deductions.append({"code": "PF", "name": "Provident Fund", "amount": pf_amt})
    deductions.append({"code": "TDS", "name": "TDS", "amount": tds_amt})
    deductions.append({"code": "ADVANCE", "name": "Advance Adjustment", "amount": adv_amt})

    late_amt = r2(snap.get("lateDed"))
    if late_amt > 0:
        deductions.append({"code": "LATE", "name": "Late Penalty", "amount": late_amt})

    other_amt = r2(snap.get("otherDed"))
    if other_amt > 0:
        deductions.append({"code": "OTHER", "name": "Other Deductions", "amount": other_amt})

    return earnings, deductions


@app.post("/api/employees/<employee_id>/payslips/publish")
@admin_auth_required
@limiter.limit("60 per hour")
def api_publish_employee_payslip(employee_id):
    """Publish the calculator preview exactly as frozen by admin (stored for employee portal + PDF)."""
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    emp = db.employees.find_one({"_id": oid})
    if not emp:
        return jsonify({"message": "Employee not found"}), 404

    body = request.get_json(force=True, silent=True) or {}
    try:
        year = int(body.get("year"))
        month = int(body.get("month"))
    except (TypeError, ValueError):
        return jsonify({"message": "year and month are required integers"}), 400

    if month < 1 or month > 12:
        return jsonify({"message": "Invalid month"}), 400

    snap = body.get("snapshot")
    if not isinstance(snap, dict):
        return jsonify({"message": "snapshot object is required"}), 400

    def r2(v) -> float:
        try:
            return round(float(v or 0), 2)
        except (TypeError, ValueError):
            return 0.0

    admin_claims = getattr(g, "admin_claims", {}) or {}
    published_by = str(admin_claims.get("sub") or "admin")

    earnings, deductions = _payslip_arrays_from_calculator_snapshot(snap)
    gross_snapshot = r2(snap.get("monthlyCtc")) or float(emp.get("monthly_salary") or 0)
    total_earnings = r2(snap.get("totalEarnings"))
    total_ded = r2(snap.get("totalDeductions"))
    net_salary = r2(snap.get("netSalary"))
    payslip_kind = str(snap.get("payslipKind") or "final").strip().lower()
    if payslip_kind not in ("final", "interim_mtd"):
        payslip_kind = "final"

    now = datetime.now(timezone.utc)
    emp_id_str = str(employee_id)
    doc = {
        "employee_id": emp_id_str,
        "employee_name": str(emp.get("name") or ""),
        "department": str(emp.get("department") or "General"),
        "year": year,
        "month": month,
        "gross_salary": total_earnings,
        "monthly_ctc_snapshot": gross_snapshot,
        "total_deductions": total_ded,
        "net_salary": net_salary,
        "earnings": earnings,
        "deductions": deductions,
        "lop_deduction": r2(snap.get("lopDed")),
        "payslip_kind": payslip_kind,
        "mtd_earned_till_publish": r2(snap.get("mtdEarned")),
        "published_by": published_by,
        "published_via": "admin_calculator",
        "status": "published",
        "generated_at": now,
        "paid_at": None,
        "working_days_snapshot": snap.get("payableDays"),
        "present_days_snapshot": snap.get("presentDays"),
        "lop_days_snapshot": snap.get("lopDays"),
        "paid_leave_snapshot": snap.get("paidLeaveDays"),
        "synced_days_snapshot": snap.get("attendanceWorkingDays"),
        "calendar_days_snapshot": snap.get("totalDaysInMonth"),
        "attendance_pct_snapshot": snap.get("attendancePct"),
        "updated_at": now,
    }

    db.payslips.replace_one(
        {"employee_id": emp_id_str, "year": year, "month": month},
        doc,
        upsert=True,
    )
    persisted = db.payslips.find_one({"employee_id": emp_id_str, "year": year, "month": month}) or {}
    slip_id = str(persisted.get("_id") or "")
    persist_mock_db_now()
    log_audit(
        "api_publish_employee_payslip",
        target={"employee_id": emp_id_str, "year": year, "month": month},
    )
    return jsonify({"message": "Salary slip published to employee portal", "payslip_id": slip_id, "year": year, "month": month}), 200


def _admin_payslip_status_response(employee_id: str):
    """Shared JSON for GET payslip workflow status (year/month query params)."""
    try:
        year = int(request.args.get("year"))
        month = int(request.args.get("month"))
    except (TypeError, ValueError):
        return jsonify({"status": "none"}), 200

    emp_id_str = str(employee_id)
    existing = db.payslips.find_one({"employee_id": emp_id_str, "year": year, "month": month})
    if not existing:
        return jsonify({"status": "none"}), 200

    return jsonify({
        "status": str(existing.get("status") or "none").strip().lower(),
        "approved_at": existing.get("approved_at").isoformat() if isinstance(existing.get("approved_at"), datetime) else None,
        "approved_by": existing.get("approved_by"),
    }), 200


def _admin_payslip_approve_core(employee_id: str):
    """Approve payslip for period in JSON body. Returns (response, http_code)."""
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    emp = db.employees.find_one({"_id": oid})
    if not emp:
        return jsonify({"message": "Employee not found"}), 404

    body = request.get_json(force=True, silent=True) or {}
    try:
        year = int(body.get("year"))
        month = int(body.get("month"))
    except (TypeError, ValueError):
        return jsonify({"message": "year and month are required integers"}), 400

    if month < 1 or month > 12:
        return jsonify({"message": "Invalid month"}), 400

    emp_id_str = str(employee_id)
    existing = db.payslips.find_one({"employee_id": emp_id_str, "year": year, "month": month})
    if not existing:
        return jsonify({"message": "No published payslip found for this period. Publish first."}), 404

    now = datetime.now(timezone.utc)
    admin_claims = getattr(g, "admin_claims", {}) or {}
    approved_by = str(admin_claims.get("sub") or "admin")

    db.payslips.update_one(
        {"employee_id": emp_id_str, "year": year, "month": month},
        {"$set": {
            "status": "approved",
            "approved_by": approved_by,
            "approved_at": now,
            "updated_at": now,
        }},
    )
    persist_mock_db_now()
    log_audit(
        "api_approve_employee_payslip",
        target={"employee_id": emp_id_str, "year": year, "month": month},
    )
    return jsonify({"message": "Payslip approved. Employee can now download.", "year": year, "month": month}), 200



@admin_auth_required
@limiter.limit("60 per hour")
def api_approve_employee_payslip(employee_id):
    """Approve a published payslip so the employee can download it."""
    return _admin_payslip_approve_core(employee_id)



@admin_auth_required
@limiter.limit("60 per hour")
def api_approve_employee_payslip_compat(employee_id):
    """Compatibility path if upstream routing blocks /payslips/approve."""
    return _admin_payslip_approve_core(employee_id)



@admin_auth_required
@limiter.limit("120 per hour")
def api_get_payslip_status(employee_id):
    """Get the current status of a payslip for a given employee/year/month."""
    return _admin_payslip_status_response(employee_id)



@admin_auth_required
@limiter.limit("120 per hour")
def api_get_payslip_status_compat(employee_id):
    """Compatibility path for payslip status (some proxies return 405 on nested resource paths)."""
    return _admin_payslip_status_response(employee_id)




@admin_auth_required
@limiter.limit("120 per hour")
def api_employee_payslips_history(employee_id):
    """List stored payslips for an employee (admin)."""
    emp_id_str = str(employee_id)
    rows = list(
        db.payslips.find({"employee_id": emp_id_str}).sort([("year", -1), ("month", -1)]).limit(48)
    )
    out = []
    for row in rows:
        item = {
            "id": str(row.get("_id", "")),
            "year": row.get("year"),
            "month": row.get("month"),
            "status": str(row.get("status") or "").strip().lower(),
            "net_salary": row.get("net_salary"),
            "gross_salary": row.get("gross_salary"),
            "payslip_kind": str(row.get("payslip_kind") or "").strip().lower(),
        }
        for key in ("generated_at", "approved_at", "updated_at"):
            val = row.get(key)
            if isinstance(val, datetime):
                item[key] = val.isoformat()
            else:
                item[key] = val
        out.append(item)
    return jsonify(out), 200


@app.route("/api/employees/<employee_id>/payslips/revoke", methods=["POST", "OPTIONS"])
@admin_auth_required
@limiter.limit("60 per hour")
def api_revoke_employee_payslip(employee_id):
    """Remove approval so the employee cannot download until re-approved (published data kept)."""
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    if not db.employees.find_one({"_id": oid}):
        return jsonify({"message": "Employee not found"}), 404

    body = request.get_json(force=True, silent=True) or {}
    try:
        year = int(body.get("year"))
        month = int(body.get("month"))
    except (TypeError, ValueError):
        return jsonify({"message": "year and month are required integers"}), 400

    if month < 1 or month > 12:
        return jsonify({"message": "Invalid month"}), 400

    emp_id_str = str(employee_id)
    existing = db.payslips.find_one({"employee_id": emp_id_str, "year": year, "month": month})
    if not existing:
        return jsonify({"message": "No payslip for this period."}), 404

    now = datetime.now(timezone.utc)
    db.payslips.update_one(
        {"employee_id": emp_id_str, "year": year, "month": month},
        {"$set": {
            "status": "published",
            "approved_at": None,
            "approved_by": None,
            "updated_at": now,
        }},
    )
    persist_mock_db_now()
    log_audit(
        "api_revoke_employee_payslip",
        target={"employee_id": emp_id_str, "year": year, "month": month},
    )
    return jsonify({"message": "Approval revoked. Payslip remains published for editing.", "year": year, "month": month}), 200


@app.get("/api/assets")
@admin_auth_required
def api_list_assets():
    from bson import ObjectId
    from bson.errors import InvalidId

    employee_id = str(request.args.get("employeeId") or request.args.get("employee_id") or "").strip()
    query = {}
    try:
        page = max(1, int(request.args.get("page") or 1))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = min(50, max(1, int(request.args.get("pageSize") or request.args.get("page_size") or 12)))
    except (TypeError, ValueError):
        page_size = 12
    search = str(request.args.get("search") or "").strip()
    file_type = str(request.args.get("fileType") or request.args.get("file_type") or "").strip().lower()
    sort_key = str(request.args.get("sort") or "newest").strip().lower()
    if employee_id:
        try:
            query["employee_id"] = ObjectId(employee_id)
        except InvalidId:
            return jsonify({"message": "Invalid employee id"}), 400

    if file_type in {"image", "video", "document"}:
        query["file_type"] = file_type

    if search:
        query["file_name"] = {"$regex": re.escape(search), "$options": "i"}

    sort_map = {
        "newest": [("created_at", -1), ("_id", -1)],
        "oldest": [("created_at", 1), ("_id", 1)],
        "name": [("file_name", 1), ("created_at", -1)],
        "size": [("size", 1), ("created_at", -1)],
    }
    sort_fields = sort_map.get(sort_key, sort_map["newest"])
    total = db.assets.count_documents(query)
    skip = (page - 1) * page_size

    rows = list(db.assets.find(query).sort(sort_fields).skip(skip).limit(page_size))
    return jsonify(
        {
            "items": [_serialize_asset_doc(row) for row in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
            "has_more": (skip + len(rows)) < total,
            "max_file_size_mb": ASSET_MAX_FILE_SIZE_MB,
        }
    )


@app.get("/api/assets/files/<path:asset_path>")
def api_get_asset_file(asset_path):
    from bson import ObjectId
    from bson.errors import InvalidId

    token = _extract_bearer_token_from_request() or str(request.args.get("token") or "").strip()
    if not token:
        return jsonify({"message": "Unauthorized"}), 401

    authorized = False
    try:
        aclaims = decode_admin_token(token)
        if aclaims.get("role") == "admin":
            authorized = True
    except Exception:
        pass

    if not authorized:
        try:
            uclaims = decode_user_token(token)
            if uclaims.get("role") == "user":
                employee_name = slugify_name((uclaims.get("employee_name") or "").strip())
                emp_user = db.employees.find_one({"name": employee_name}) if employee_name else None
                first_seg = str(Path(str(asset_path or "")).parts[0] if Path(str(asset_path or "")).parts else "")
                try:
                    folder_oid = ObjectId(first_seg)
                except (InvalidId, Exception):
                    folder_oid = None
                if emp_user and folder_oid and emp_user.get("_id") == folder_oid:
                    authorized = True
        except Exception:
            pass

    if not authorized:
        return jsonify({"message": "Unauthorized"}), 401

    base_dir = ASSETS_DIR.resolve()
    candidate = (base_dir / str(asset_path or "")).resolve()
    if str(candidate).startswith(str(base_dir)) is False:
        return jsonify({"message": "Invalid file path"}), 400
    if not candidate.exists() or not candidate.is_file():
        return jsonify({"message": "File not found"}), 404

    as_download = str(request.args.get("download") or "").strip().lower() in {"1", "true", "yes", "on"}
    return send_file(str(candidate), as_attachment=as_download)


@app.post("/api/assets")
@admin_auth_required
@limiter.limit("240 per hour")
def api_upload_asset():
    from bson import ObjectId
    from bson.errors import InvalidId

    employee_id = str(request.form.get("employeeId") or request.form.get("employee_id") or "").strip()
    if not employee_id:
        return jsonify({"message": "employeeId is required"}), 400

    try:
        employee_oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    employee = db.employees.find_one({"_id": employee_oid})
    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    uploaded = request.files.get("file")
    if uploaded is None or not uploaded.filename:
        return jsonify({"message": "File is required"}), 400

    raw = uploaded.read()
    if not raw:
        return jsonify({"message": "Uploaded file is empty"}), 400

    original_name = Path(str(uploaded.filename or "")).name or "file"
    guessed_mime = mimetypes.guess_type(original_name)[0] or "application/octet-stream"
    mime_type = str(uploaded.mimetype or guessed_mime or "application/octet-stream").strip().lower()
    valid, validation_error, validated_type = _validate_asset_upload(original_name, mime_type, len(raw))
    if not valid:
        code = 413 if validation_error == "File too large" else 400
        return jsonify({"message": validation_error}), code

    file_type = validated_type or _asset_type_from_file(original_name, mime_type)
    checksum = hashlib.sha256(raw).hexdigest()
    duplicate = db.assets.find_one({"employee_id": employee_oid, "checksum": checksum})
    if duplicate:
        return jsonify({"message": "Duplicate file already uploaded"}), 409

    normalized_name = _safe_asset_filename(original_name)
    unique_name = _build_unique_asset_display_name(employee_oid, normalized_name)
    storage_provider = "local"
    public_id = ""

    if cloudinary_enabled:
        public_id = f"{CLOUDINARY_ASSETS_FOLDER}/{employee_oid}/{uuid.uuid4().hex}_{Path(unique_name).stem}"
        resource_type = _cloudinary_resource_type(file_type)
        try:
            upload_result = cloudinary.uploader.upload(
                io.BytesIO(raw),
                resource_type=resource_type,
                public_id=public_id,
                use_filename=False,
                unique_filename=False,
                overwrite=False,
                filename=unique_name,
            )
            file_url = str(upload_result.get("secure_url") or upload_result.get("url") or "").strip()
            if not file_url:
                raise RuntimeError("Cloudinary did not return URL")
            storage_provider = "cloudinary"
        except Exception as exc:
            return jsonify({"message": f"Cloudinary upload failed: {str(exc)}"}), 502
    else:
        stored_name = f"{uuid.uuid4().hex}_{_safe_asset_filename(unique_name)}"
        employee_dir = ASSETS_DIR / str(employee_oid)
        ensure_dir(employee_dir)
        target = employee_dir / stored_name
        with target.open("wb") as fp:
            fp.write(raw)
        file_url = f"/api/assets/files/{employee_oid}/{stored_name}"

    now = datetime.now()
    admin_claims = getattr(g, "admin_claims", {}) or {}

    doc = {
        "employee_id": employee_oid,
        "file_url": file_url,
        "file_name": unique_name,
        "file_type": file_type,
        "mime_type": mime_type,
        "size": len(raw),
        "checksum": checksum,
        "storage_provider": storage_provider,
        "public_id": public_id,
        "uploaded_by": str(admin_claims.get("sub") or "admin"),
        "created_at": now,
        "updated_at": now,
    }

    inserted = db.assets.insert_one(doc)
    persist_mock_db_now()
    row = db.assets.find_one({"_id": inserted.inserted_id})
    return jsonify({"message": "Asset uploaded", "asset": _serialize_asset_doc(row)}), 201


@app.patch("/api/assets/<asset_id>/rename")
@admin_auth_required
@limiter.limit("240 per hour")
def api_rename_asset(asset_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(asset_id)
    except InvalidId:
        return jsonify({"message": "Invalid asset id"}), 400

    row = db.assets.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Asset not found"}), 404

    payload = request.get_json(silent=True) or {}
    requested_name = str(payload.get("file_name") or payload.get("name") or "").strip()
    if not requested_name:
        return jsonify({"message": "File name is required"}), 400

    safe_input = _safe_asset_filename(requested_name)
    old_name = str(row.get("file_name") or "file")
    old_ext = Path(old_name).suffix.lower()
    next_ext = Path(safe_input).suffix.lower()
    if not next_ext and old_ext:
        safe_input = f"{Path(safe_input).stem or 'file'}{old_ext}"

    if Path(safe_input).suffix.lower() not in ALLOWED_ASSET_EXTENSIONS:
        return jsonify({"message": "Unsupported file format"}), 400

    unique_name = _build_unique_asset_display_name(row.get("employee_id"), safe_input, exclude_asset_id=oid)
    db.assets.update_one(
        {"_id": oid},
        {"$set": {"file_name": unique_name, "updated_at": datetime.now()}},
    )
    persist_mock_db_now()
    updated = db.assets.find_one({"_id": oid})
    return jsonify({"message": "Asset renamed", "asset": _serialize_asset_doc(updated)})


@app.get("/api/assets/download-all")
@admin_auth_required
@limiter.limit("120 per hour")
def api_download_all_assets_zip():
    from bson import ObjectId
    from bson.errors import InvalidId

    employee_id = str(request.args.get("employeeId") or request.args.get("employee_id") or "").strip()
    if not employee_id:
        return jsonify({"message": "employeeId is required"}), 400
    try:
        employee_oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400

    employee = db.employees.find_one({"_id": employee_oid}) or {}
    rows = list(db.assets.find({"employee_id": employee_oid}).sort("created_at", -1))
    if not rows:
        return jsonify({"message": "No assets found for employee"}), 404

    buffer = io.BytesIO()
    used_names = set()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for row in rows:
            display_name = _safe_asset_filename(str(row.get("file_name") or "file"))
            normalized_archive_name = display_name
            name_index = 1
            while normalized_archive_name.lower() in used_names:
                stem = Path(display_name).stem or "file"
                ext = Path(display_name).suffix.lower()
                normalized_archive_name = f"{stem}({name_index}){ext}"
                name_index += 1
            used_names.add(normalized_archive_name.lower())

            storage_provider = str(row.get("storage_provider") or "local").strip().lower()
            if storage_provider == "cloudinary":
                source_url = str(row.get("file_url") or "").strip()
                if not source_url:
                    continue
                try:
                    with io.BytesIO() as chunk:
                        with urlopen(source_url, timeout=20) as response:
                            chunk.write(response.read())
                        archive.writestr(normalized_archive_name, chunk.getvalue())
                except Exception:
                    continue
            else:
                file_url = str(row.get("file_url") or "")
                rel_path = file_url.replace("/api/assets/files/", "", 1).lstrip("/")
                candidate = (ASSETS_DIR.resolve() / rel_path).resolve()
                if str(candidate).startswith(str(ASSETS_DIR.resolve())) and candidate.exists() and candidate.is_file():
                    try:
                        archive.write(str(candidate), arcname=normalized_archive_name)
                    except Exception:
                        continue

    buffer.seek(0)
    employee_key = slugify_name(str(employee.get("name") or employee_id)) or employee_id
    return send_file(
        buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{employee_key}-assets.zip",
    )


@app.delete("/api/assets/<asset_id>")
@admin_auth_required
@limiter.limit("240 per hour")
def api_delete_asset(asset_id):
    from bson import ObjectId
    from bson.errors import InvalidId

    try:
        oid = ObjectId(asset_id)
    except InvalidId:
        return jsonify({"message": "Invalid asset id"}), 400

    row = db.assets.find_one({"_id": oid})
    if not row:
        return jsonify({"message": "Asset not found"}), 404

    storage_provider = str(row.get("storage_provider") or "local").strip().lower()
    if storage_provider == "cloudinary" and cloudinary_enabled:
        public_id = str(row.get("public_id") or "").strip()
        file_type = str(row.get("file_type") or "document").strip().lower()
        if public_id:
            try:
                cloudinary.uploader.destroy(
                    public_id,
                    resource_type=_cloudinary_resource_type(file_type),
                    invalidate=True,
                )
            except Exception:
                pass
    else:
        file_url = str(row.get("file_url") or "")
        rel_path = file_url.replace("/api/assets/files/", "", 1).lstrip("/")
        candidate = (ASSETS_DIR.resolve() / rel_path).resolve()
        if str(candidate).startswith(str(ASSETS_DIR.resolve())) and candidate.exists() and candidate.is_file():
            try:
                candidate.unlink(missing_ok=True)
            except Exception:
                pass

    db.assets.delete_one({"_id": oid})
    persist_mock_db_now()
    return jsonify({"message": "Asset deleted", "id": asset_id})


def _list_catalog_items(kind: str):
    collection, _ = _catalog_collection(kind)
    rows = list(collection.find().sort("name", 1)) if collection is not None else []
    return [_serialize_catalog_doc(row) for row in rows]


def _create_catalog_item(kind: str):
    collection, label = _catalog_collection(kind)
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()
    if not name:
        return jsonify({"message": f"{label.title()} name is required"}), 400
    if len(name) > 64:
        return jsonify({"message": f"{label.title()} name must be at most 64 characters"}), 400

    now = datetime.now()
    try:
        inserted = collection.insert_one({"name": name, "created_at": now, "updated_at": now})
    except DuplicateKeyError:
        return jsonify({"message": f"{label.title()} already exists"}), 409

    persist_mock_db_now()
    row = collection.find_one({"_id": inserted.inserted_id})
    return jsonify({"message": f"{label.title()} created", label: _serialize_catalog_doc(row)}), 201


def _update_catalog_item(kind: str, item_id: str):
    collection, label = _catalog_collection(kind)
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()
    if not name:
        return jsonify({"message": f"{label.title()} name is required"}), 400
    if len(name) > 64:
        return jsonify({"message": f"{label.title()} name must be at most 64 characters"}), 400

    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(item_id)
    except InvalidId:
        return jsonify({"message": f"Invalid {label} id"}), 400

    if not collection.find_one({"_id": oid}):
        return jsonify({"message": f"{label.title()} not found"}), 404

    try:
        collection.update_one({"_id": oid}, {"$set": {"name": name, "updated_at": datetime.now()}})
    except DuplicateKeyError:
        return jsonify({"message": f"{label.title()} already exists"}), 409

    persist_mock_db_now()
    row = collection.find_one({"_id": oid})
    return jsonify({"message": f"{label.title()} updated", label: _serialize_catalog_doc(row)})


def _delete_catalog_item(kind: str, item_id: str):
    collection, label = _catalog_collection(kind)
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(item_id)
    except InvalidId:
        return jsonify({"message": f"Invalid {label} id"}), 400

    current = collection.find_one({"_id": oid})
    if not current:
        return jsonify({"message": f"{label.title()} not found"}), 404

    collection.delete_one({"_id": oid})
    persist_mock_db_now()
    return jsonify({"message": f"{label.title()} deleted", label: _serialize_catalog_doc(current)})


@app.get("/api/departments")
@admin_auth_required
def api_get_departments():
    return jsonify({"items": _list_catalog_items("departments")})


@app.post("/api/departments")
@admin_auth_required
@limiter.limit("120 per hour")
def api_create_department():
    return _create_catalog_item("departments")


@app.put("/api/departments/<item_id>")
@admin_auth_required
@limiter.limit("120 per hour")
def api_update_department(item_id):
    return _update_catalog_item("departments", item_id)


@app.delete("/api/departments/<item_id>")
@admin_auth_required
@limiter.limit("120 per hour")
def api_delete_department(item_id):
    return _delete_catalog_item("departments", item_id)


@app.get("/api/roles")
@admin_auth_required
def api_get_roles():
    return jsonify({"items": _list_catalog_items("roles")})


@app.post("/api/roles")
@admin_auth_required
@limiter.limit("120 per hour")
def api_create_role():
    return _create_catalog_item("roles")


@app.put("/api/roles/<item_id>")
@admin_auth_required
@limiter.limit("120 per hour")
def api_update_role(item_id):
    return _update_catalog_item("roles", item_id)


@app.delete("/api/roles/<item_id>")
@admin_auth_required
@limiter.limit("120 per hour")
def api_delete_role(item_id):
    return _delete_catalog_item("roles", item_id)


@app.get("/employees")
@admin_auth_required
def get_employees():
    rows = attendance_manager.list_employees()
    return jsonify([_serialize_employee_doc(row) for row in rows])


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
    _sync_employee_references(oid, {"name": new_name})
    log_audit("update_employee", target={"employee_id": employee_id, "name": new_name, "login_id": new_login_id})

    auto_train_job_id = _start_training_if_idle()

    return jsonify(
        {
            "message": "Employee updated",
            "employee": result["employee"],
            "dashboard": _dashboard_summary_for_date(),
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


@app.errorhandler(429)
def handle_rate_limit(_error):
    return jsonify({"status": "rate_limited", "message": "Too many requests. Please wait a moment and try again."}), 429


@app.errorhandler(404)
def handle_not_found(error):
    return jsonify({
        "success": False,
        "message": "Route not found",
        "details": {"method": request.method, "path": request.path},
    }), 404


@app.errorhandler(405)
def handle_method_not_allowed(error):
    allowed = sorted(getattr(error, "valid_methods", []) or [])
    return jsonify({
        "success": False,
        "message": "Method not allowed",
        "details": {"method": request.method, "path": request.path, "allowed_methods": allowed},
    }), 405


@app.errorhandler(400)
def handle_bad_request(error):
    return jsonify({
        "success": False,
        "message": "Bad request",
        "details": {
            "method": request.method,
            "path": request.path,
            "query": dict(request.args),
            "body": request.get_json(silent=True),
        },
    }), 400


@app.errorhandler(Exception)
def handle_unhandled_exception(error):
    if isinstance(error, HTTPException):
        status_code = int(getattr(error, "code", 500) or 500)
        details = {}
        valid_methods = getattr(error, "valid_methods", None)
        if status_code == 405 and valid_methods:
            details["allowed_methods"] = list(valid_methods)

        payload = {
            "error": str(getattr(error, "name", "http_error") or "http_error").lower().replace(" ", "_"),
            "message": str(getattr(error, "description", "Request failed") or "Request failed"),
        }
        if details:
            payload["details"] = details

        return jsonify(payload), status_code

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
    return (
        jsonify(
            {
                "error": "internal_error",
                "message": "Internal server error",
                "details": {"request_id": getattr(g, "request_id", None), "path": request.path if request else None},
            }
        ),
        500,
    )


# =============================================================================
# PAYROLL ENGINE – Routes
# =============================================================================
PAYROLL_STATUS_DRAFT = "draft"
PAYROLL_STATUS_PROCESSING = "processing"
PAYROLL_STATUS_PAID = "paid"
PAYROLL_STATUS_FAILED = "failed"

try:
    from src.payroll.calculator import PayrollCalculator, get_working_days_in_month as _gwdim, start_payroll_scheduler, PAYROLL_STATUS_DRAFT, PAYROLL_STATUS_PAID, PAYROLL_STATUS_PROCESSING, PAYROLL_STATUS_FAILED
    _payroll_calculator = PayrollCalculator(db)
    start_payroll_scheduler(db, interval_seconds=3600)
    logger.info("payroll_engine_loaded")
except Exception as _pe:
    logger.warning("payroll_engine_load_failed: %s", _pe)
    _payroll_calculator = None


def _payroll_ok():
    return _payroll_calculator is not None


def _today_ist_date():
    from datetime import timezone as _tz
    ist_offset = timedelta(hours=5, minutes=30)
    return (datetime.utcnow() + ist_offset).date()


# ── MongoDB indexes for payroll collections ────────────────────────────────
try:
    db.salary_ledger.create_index([("employeeId", 1), ("date", 1)], unique=True)
    db.salary_ledger.create_index([("employeeId", 1), ("date", -1)])
    db.payroll_summary.create_index([("employeeId", 1), ("year", 1), ("month", 1)], unique=True)
    db.payroll_summary.create_index([("year", 1), ("month", 1)])
    db.holidays.create_index([("date", 1)])
except Exception:
    pass


# ── Work Policy ───────────────────────────────────────────────────────────────

@app.get("/api/work-policy/<employee_id>")
@admin_auth_required
def get_work_policy(employee_id):
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400
    emp = db.employees.find_one({"_id": oid})
    if not emp:
        return jsonify({"message": "Employee not found"}), 404
    default_policy = {
        "saturdayPolicy": "OFF",
        "shiftStart": "09:00",
        "shiftEnd": "18:00",
        "graceMinutes": 15,
        "overtimeEligible": True,
        "paidLeavesPerMonth": 2,
        "lateDeductionEnabled": False,
        "lateDeductionPerMinute": 0.0,
    }
    policy = dict(default_policy)
    stored = emp.get("work_policy") or {}
    if isinstance(stored, dict):
        policy.update(stored)
    return jsonify({
        "employeeId": employee_id,
        "monthlySalary": float(emp.get("monthly_salary") or 0.0),
        "workPolicy": policy,
    })


@app.put("/api/work-policy/<employee_id>")
@admin_auth_required
def update_work_policy(employee_id):
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(employee_id)
    except InvalidId:
        return jsonify({"message": "Invalid employee id"}), 400
    emp = db.employees.find_one({"_id": oid})
    if not emp:
        return jsonify({"message": "Employee not found"}), 404
    payload = request.get_json(silent=True) or {}
    updates = {}
    if "monthlySalary" in payload:
        updates["monthly_salary"] = max(0.0, float(payload["monthlySalary"] or 0))
    if "monthly_salary" in payload:
        updates["monthly_salary"] = max(0.0, float(payload["monthly_salary"] or 0))
    if "workPolicy" in payload and isinstance(payload["workPolicy"], dict):
        updates["work_policy"] = payload["workPolicy"]
    if not updates:
        return jsonify({"message": "No updates provided"}), 400
    updates["updated_at"] = datetime.now()
    db.employees.update_one({"_id": oid}, {"$set": updates})
    return jsonify({"message": "Work policy updated"})


# ── Payroll Employees Table ────────────────────────────────────────────────────

@app.get("/api/payroll/employees")
@admin_auth_required
def payroll_employees():
    """Return payroll summary for each active employee for the current month."""
    try:
        year = int(request.args.get("year") or _today_ist_date().year)
        month = int(request.args.get("month") or _today_ist_date().month)
    except (TypeError, ValueError):
        today = _today_ist_date()
        year, month = today.year, today.month

    today = _today_ist_date()
    up_to_day = today.day if (year == today.year and month == today.month) else None

    employees = list(db.employees.find({"status": "active"}))
    results = []
    for emp in employees:
        try:
            if _payroll_ok():
                summary = _payroll_calculator.get_month_summary(emp, year, month, up_to_day)
            else:
                monthly_salary = float(emp.get("monthly_salary") or 0.0)
                summary = {
                    "employeeId": str(emp.get("_id", "")),
                    "employeeName": str(emp.get("name") or ""),
                    "monthlySalary": monthly_salary,
                    "earnedTillNow": 0.0,
                    "totalDeductions": 0.0,
                    "totalOvertime": 0.0,
                    "finalPayable": 0.0,
                    "attendancePercentage": 0.0,
                    "payrollStatus": PAYROLL_STATUS_DRAFT if _payroll_ok() else "draft",
                }
            emp_s = _serialize_employee_doc(emp)
            summary["department"] = emp_s.get("department", "")
            summary["role"] = emp_s.get("role", "")
            summary["salary_type"] = emp_s.get("salary_type", "CTC_BASED")
            # Check if there's a locked payroll summary in DB
            locked = db.payroll_summary.find_one({"employeeId": summary["employeeId"], "year": year, "month": month})
            if locked:
                summary["payrollStatus"] = locked.get("payrollStatus", PAYROLL_STATUS_DRAFT)
                summary["finalPayable"] = locked.get("finalPayable", summary["finalPayable"])
            else:
                summary["payrollStatus"] = PAYROLL_STATUS_DRAFT

            # Derived convenience fields
            monthly_sal = float(summary.get("monthlySalary") or 0)
            earned      = float(summary.get("earnedTillNow") or 0)
            import calendar as _pcal

            _, _plen = _pcal.monthrange(year, month)
            cal_den = max(int(_plen), int(summary.get("calendarDaysInFullMonth") or 0))
            cal_den = max(1, cal_den)
            daily_rate   = monthly_sal / cal_den if monthly_sal > 0 else 0.0
            summary["remainingSalary"] = round(max(0.0, monthly_sal - earned), 2)
            summary["dailyRate"]       = round(daily_rate, 2)

            # Today's earnings from dailyEntries
            today_earnings = 0.0
            for de in summary.get("dailyEntries", []):
                if de.get("date") == today.isoformat():
                    today_earnings = float(de.get("finalAmount") or 0.0)
                    break
            summary["todayEarnings"] = round(today_earnings, 2)
            # Remove heavyweight dailyEntries from list response
            summary.pop("dailyEntries", None)

            results.append(summary)
        except Exception as exc:
            logger.exception("payroll_employee_error for %s: %s", str(emp.get("_id", "")), exc)

    return jsonify({
        "year": year,
        "month": month,
        "employees": results,
        "total": len(results),
    })


# ── Payroll Monthly Summary ────────────────────────────────────────────────────

@app.get("/api/payroll/summary")
@admin_auth_required
def payroll_summary():
    """Return aggregate payroll totals for the month."""
    try:
        year = int(request.args.get("year") or _today_ist_date().year)
        month = int(request.args.get("month") or _today_ist_date().month)
    except (TypeError, ValueError):
        today = _today_ist_date()
        year, month = today.year, today.month

    today = _today_ist_date()
    up_to_day = today.day if (year == today.year and month == today.month) else None

    employees = list(db.employees.find({"status": "active"}))
    total_payroll = 0.0
    total_deductions = 0.0
    total_overtime = 0.0
    total_final_payable = 0.0
    paid_count = 0
    total_employees = len(employees)

    for emp in employees:
        try:
            if _payroll_ok():
                s = _payroll_calculator.get_month_summary(emp, year, month, up_to_day)
            else:
                s = {
                    "monthlySalary": float(emp.get("monthly_salary") or 0.0),
                    "totalDeductions": 0.0,
                    "totalOvertime": 0.0,
                    "finalPayable": float(emp.get("monthly_salary") or 0.0),
                }
            total_payroll += float(s.get("monthlySalary") or 0.0)
            total_deductions += float(s.get("totalDeductions") or 0.0)
            total_overtime += float(s.get("totalOvertime") or 0.0)
            total_final_payable += float(s.get("finalPayable") or 0.0)

            locked = db.payroll_summary.find_one({"employeeId": str(emp.get("_id", "")), "year": year, "month": month})
            if locked and locked.get("payrollStatus") == PAYROLL_STATUS_PAID:
                paid_count += 1
        except Exception:
            pass

    avg_salary = round(total_payroll / total_employees, 2) if total_employees > 0 else 0.0
    pending = total_employees - paid_count

    return jsonify({
        "year": year,
        "month": month,
        "totalPayroll": round(total_payroll, 2),
        "totalDeductions": round(total_deductions, 2),
        "totalOvertime": round(total_overtime, 2),
        "totalFinalPayable": round(total_final_payable, 2),
        "totalEmployees": total_employees,
        "paidCount": paid_count,
        "pendingCount": pending,
        "averageSalary": avg_salary,
    })


# ── Payroll Calculate / Trigger ────────────────────────────────────────────────

@app.post("/api/payroll/calculate")
@admin_auth_required
def payroll_calculate():
    """Trigger payroll recalculation for a month (or just one employee)."""
    payload = request.get_json(silent=True) or {}
    try:
        year = int(payload.get("year") or _today_ist_date().year)
        month = int(payload.get("month") or _today_ist_date().month)
    except (TypeError, ValueError):
        today = _today_ist_date()
        year, month = today.year, today.month

    employee_id = str(payload.get("employeeId") or "").strip()

    if not _payroll_ok():
        return jsonify({"message": "Payroll engine not available"}), 503

    if employee_id:
        from bson import ObjectId
        try:
            emp = db.employees.find_one({"_id": ObjectId(employee_id)})
        except Exception:
            emp = None
        if not emp:
            return jsonify({"message": "Employee not found"}), 404
        count = _payroll_calculator.upsert_salary_ledger(emp, year, month)
        return jsonify({"message": "Calculated", "entriesWritten": count, "year": year, "month": month})
    else:
        result = _payroll_calculator.run_daily_update()
        return jsonify({"message": "Daily update triggered", **result})


# ── Mark Payroll Status ────────────────────────────────────────────────────────

@app.put("/api/payroll/status")
@admin_auth_required
def update_payroll_status():
    """Mark payroll as paid/processing/failed for an employee+month."""
    payload = request.get_json(silent=True) or {}
    employee_id = str(payload.get("employeeId") or "").strip()
    try:
        year = int(payload.get("year") or _today_ist_date().year)
        month = int(payload.get("month") or _today_ist_date().month)
    except (TypeError, ValueError):
        today = _today_ist_date()
        year, month = today.year, today.month
    new_status = str(payload.get("status") or PAYROLL_STATUS_PAID).strip()
    if new_status not in (PAYROLL_STATUS_DRAFT, PAYROLL_STATUS_PROCESSING, PAYROLL_STATUS_PAID, PAYROLL_STATUS_FAILED):
        return jsonify({"message": "Invalid status"}), 400
    if not employee_id:
        return jsonify({"message": "employeeId required"}), 400

    db.payroll_summary.update_one(
        {"employeeId": employee_id, "year": year, "month": month},
        {"$set": {"payrollStatus": new_status, "updatedAt": datetime.utcnow().isoformat()}},
        upsert=True,
    )
    return jsonify({"message": "Status updated"})


# ── Salary Ledger ─────────────────────────────────────────────────────────────

@app.get("/api/salary-ledger")
@admin_auth_required
def get_salary_ledger():
    """Get daily salary ledger for an employee+month."""
    employee_id = str(request.args.get("employeeId") or "").strip()
    try:
        year = int(request.args.get("year") or _today_ist_date().year)
        month = int(request.args.get("month") or _today_ist_date().month)
    except (TypeError, ValueError):
        today = _today_ist_date()
        year, month = today.year, today.month

    if not employee_id:
        return jsonify({"message": "employeeId required"}), 400

    from bson import ObjectId
    try:
        emp = db.employees.find_one({"_id": ObjectId(employee_id)})
    except Exception:
        emp = None

    if not emp:
        return jsonify({"message": "Employee not found"}), 404

    today = _today_ist_date()
    up_to_day = today.day if (year == today.year and month == today.month) else None

    if _payroll_ok():
        entries = _payroll_calculator.calculate_employee_month(emp, year, month, up_to_day)
    else:
        entries = []

    return jsonify({
        "employeeId": employee_id,
        "year": year,
        "month": month,
        "entries": entries,
    })


# ── Attendance Analytics ──────────────────────────────────────────────────────

@app.get("/api/attendance/analytics")
@admin_auth_required
def attendance_analytics_v2():
    """Return attendance analytics for a date range."""
    from bson import ObjectId
    import calendar as _cal
    today = _today_ist_date()
    try:
        year = int(request.args.get("year") or today.year)
        month = int(request.args.get("month") or today.month)
    except (TypeError, ValueError):
        year, month = today.year, today.month

    _, last_day = _cal.monthrange(year, month)
    start_str = f"{year}-{month:02d}-01"
    end_str = f"{year}-{month:02d}-{last_day:02d}"

    att_rows = list(db.attendance.find({"date": {"$gte": start_str, "$lte": end_str}}))

    # Aggregate per employee
    emp_stats: dict = {}
    for row in att_rows:
        eid = str(row.get("employee_id") or "")
        if not eid:
            continue
        if eid not in emp_stats:
            emp_stats[eid] = {"present": 0, "absent": 0, "late": 0, "half_day": 0, "leave": 0, "total": 0, "work_hours": 0.0}
        status = str(row.get("status") or "").lower()
        emp_stats[eid]["total"] += 1
        if status in ("present", "p"):
            emp_stats[eid]["present"] += 1
        elif status == "absent":
            emp_stats[eid]["absent"] += 1
        elif status == "late":
            emp_stats[eid]["late"] += 1
            emp_stats[eid]["present"] += 1
        elif "half" in status:
            emp_stats[eid]["half_day"] += 1
        elif status == "leave":
            emp_stats[eid]["leave"] += 1
        try:
            wh = float(row.get("work_hours") or row.get("total_hours") or 0.0)
            emp_stats[eid]["work_hours"] += wh
        except (TypeError, ValueError):
            pass

    # Build response
    total_present = sum(v["present"] for v in emp_stats.values())
    total_absent = sum(v["absent"] for v in emp_stats.values())
    total_late = sum(v["late"] for v in emp_stats.values())
    total_records = sum(v["total"] for v in emp_stats.values())

    present_pct = round((total_present / total_records) * 100, 1) if total_records > 0 else 0.0
    absent_pct = round((total_absent / total_records) * 100, 1) if total_records > 0 else 0.0
    late_pct = round((total_late / total_records) * 100, 1) if total_records > 0 else 0.0

    # Most punctual / need attention
    punctual = []
    attention = []
    for eid, stats in emp_stats.items():
        pct = round((stats["present"] / stats["total"]) * 100, 1) if stats["total"] > 0 else 0.0
        emp_doc = db.employees.find_one({"_id": ObjectId(eid)}) if len(eid) == 24 else None
        name = str(emp_doc.get("name") or eid) if emp_doc else eid
        dept = str(emp_doc.get("department") or "") if emp_doc else ""
        record = {"employeeId": eid, "name": name, "department": dept, "attendancePct": pct, **stats}
        if pct >= 95:
            punctual.append(record)
        elif pct < 75:
            attention.append(record)

    avg_work_hours = 0.0
    if emp_stats:
        total_wh = sum(v["work_hours"] for v in emp_stats.values())
        total_days_wh = sum(v["present"] for v in emp_stats.values())
        avg_work_hours = round(total_wh / total_days_wh, 2) if total_days_wh > 0 else 0.0

    return jsonify({
        "year": year,
        "month": month,
        "presentPct": present_pct,
        "absentPct": absent_pct,
        "latePct": late_pct,
        "avgWorkHours": avg_work_hours,
        "totalRecords": total_records,
        "mostPunctual": sorted(punctual, key=lambda x: -x["attendancePct"])[:5],
        "needAttention": sorted(attention, key=lambda x: x["attendancePct"])[:5],
    })


# ── Holidays API ──────────────────────────────────────────────────────────────

@app.get("/api/holidays")
@admin_auth_required
def get_holidays():
    try:
        year = int(request.args.get("year") or _today_ist_date().year)
    except (TypeError, ValueError):
        year = _today_ist_date().year
    docs = list(db.holidays.find({"date": {"$regex": f"^{year}-"}}))
    items = []
    for d in docs:
        d["id"] = str(d.pop("_id"))
        items.append(d)
    return jsonify(items)


@app.post("/api/holidays")
@admin_auth_required
def create_holiday():
    payload = request.get_json(silent=True) or {}
    date_str = str(payload.get("date") or "").strip()
    name = str(payload.get("name") or "").strip()
    if not date_str or not name:
        return jsonify({"message": "date and name are required"}), 400
    doc = {
        "date": date_str,
        "name": name,
        "paid": bool(payload.get("paid", True)),
        "created_at": datetime.utcnow().isoformat(),
    }
    db.holidays.update_one({"date": date_str}, {"$set": doc}, upsert=True)
    return jsonify({"message": "Holiday saved"}), 201


@app.delete("/api/holidays/<date_str>")
@admin_auth_required
def delete_holiday(date_str):
    db.holidays.delete_one({"date": date_str})
    return jsonify({"message": "Holiday deleted"})


# =============================================================================
# END PAYROLL ENGINE ROUTES
# =============================================================================

try:
    _ensure_default_company_catalog()
    _seed_demo_workforce_if_mock_empty()
except Exception:
    app.logger.exception("default company catalog bootstrap failed")


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    debug_mode = str(os.getenv("FLASK_DEBUG", "false")).strip().lower() in {"1", "true", "yes", "on"}
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
