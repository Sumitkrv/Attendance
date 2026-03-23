import base64
import json
import mimetypes
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Dict, List, Optional, Tuple

BASE = os.getenv("API_BASE_URL", "http://127.0.0.1:5001")
ADMIN_USER = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASS = os.getenv("ADMIN_PASSWORD", "admin123")
REG_USER_LOGIN = str(os.getenv("REGRESSION_USER_LOGIN_ID", "") or "").strip().lower()
REG_USER_PASSWORD = str(os.getenv("REGRESSION_USER_PASSWORD", "") or "")
REG_MISMATCH_USER = str(os.getenv("REGRESSION_MISMATCH_USER_LOGIN_ID", "") or "").strip().lower()


def _decode_jwt_payload(token: str) -> Dict:
    part = token.split(".")[1]
    part += "=" * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part.encode("utf-8")).decode("utf-8"))


def _json_request(
    path: str,
    method: str = "GET",
    payload: Optional[Dict] = None,
    token: Optional[str] = None,
    timeout: int = 20,
) -> Tuple[int, Dict]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer {}".format(token)

    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request("{}{}".format(BASE, path), data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            return int(resp.status), json.loads(text or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw or "{}")
        except Exception:
            data = {"raw": raw[:500]}
        return int(exc.code), data


def _form_request(
    path: str,
    fields: Optional[Dict[str, str]] = None,
    token: Optional[str] = None,
    timeout: int = 20,
) -> Tuple[int, Dict]:
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if token:
        headers["Authorization"] = "Bearer {}".format(token)

    encoded = urllib.parse.urlencode(fields or {}).encode("utf-8")
    req = urllib.request.Request("{}{}".format(BASE, path), data=encoded, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            return int(resp.status), json.loads(text or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw or "{}")
        except Exception:
            data = {"raw": raw[:500]}
        return int(exc.code), data


def _multipart_request(
    path: str,
    file_path: pathlib.Path,
    fields: Dict[str, str],
    token: str,
    timeout: int = 40,
) -> Tuple[int, Dict]:
    boundary = "----fa{}".format(uuid.uuid4().hex)
    chunks: List[bytes] = []

    def add_line(line: str) -> None:
        chunks.append(line.encode("utf-8"))
        chunks.append(b"\r\n")

    for key, value in (fields or {}).items():
        add_line("--{}".format(boundary))
        add_line('Content-Disposition: form-data; name="{}"'.format(key))
        add_line("")
        add_line(str(value))

    ctype = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    add_line("--{}".format(boundary))
    add_line('Content-Disposition: form-data; name="image"; filename="{}"'.format(file_path.name))
    add_line("Content-Type: {}".format(ctype))
    add_line("")
    chunks.append(file_path.read_bytes())
    chunks.append(b"\r\n")
    add_line("--{}--".format(boundary))

    body = b"".join(chunks)
    headers = {
        "Content-Type": "multipart/form-data; boundary={}".format(boundary),
        "Authorization": "Bearer {}".format(token),
    }

    req = urllib.request.Request("{}{}".format(BASE, path), data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            return int(resp.status), json.loads(text or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw or "{}")
        except Exception:
            data = {"raw": raw[:500]}
        return int(exc.code), data


def _first_image_for_employee(employee: Dict) -> Optional[pathlib.Path]:
    candidates: List[pathlib.Path] = []

    folder_raw = str(employee.get("image_folder") or "").strip()
    if folder_raw:
        candidates.append(pathlib.Path(folder_raw))

    name = str(employee.get("name") or "").strip()
    if name:
        candidates.append(pathlib.Path(__file__).resolve().parents[2] / "persistent" / "dataset" / name)

    exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    for folder in candidates:
        if not folder.exists() or not folder.is_dir():
            continue
        images = sorted([p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in exts])
        if images:
            return images[0]
    return None


def _pick_test_users(employees: List[Dict]) -> Tuple[Optional[Dict], Optional[Dict], List[str]]:
    usable: List[Dict] = []
    reasons: List[str] = []

    for row in employees:
        if not str(row.get("login_id") or "").strip():
            reasons.append("skip {}: missing login_id".format(row.get("name")))
            continue
        img = _first_image_for_employee(row)
        if not img:
            reasons.append("skip {}: no usable image file".format(row.get("name")))
            continue

        copy_row = dict(row)
        copy_row["_test_image"] = str(img)
        usable.append(copy_row)

    if not usable:
        return None, None, reasons

    login_user = None
    mismatch_user = None

    if REG_USER_LOGIN:
        login_user = next((u for u in usable if str(u.get("login_id") or "").strip().lower() == REG_USER_LOGIN), None)
        if not login_user:
            reasons.append("missing REGRESSION_USER_LOGIN_ID in employees list")
    else:
        login_user = usable[0]

    if REG_MISMATCH_USER:
        mismatch_user = next((u for u in usable if str(u.get("login_id") or "").strip().lower() == REG_MISMATCH_USER), None)
        if not mismatch_user:
            reasons.append("missing REGRESSION_MISMATCH_USER_LOGIN_ID in employees list")

    if mismatch_user is None:
        mismatch_user = next((u for u in usable if login_user and u.get("id") != login_user.get("id")), None)

    if not login_user or not mismatch_user:
        return None, None, reasons

    return login_user, mismatch_user, reasons


def _wait_for_training(admin_token: str, timeout_sec: int = 120) -> bool:
    started_at = time.time()
    while time.time() - started_at <= timeout_sec:
        code, state = _json_request("/train_model/status", token=admin_token)
        if code == 200 and not bool((state or {}).get("running")):
            return True
        time.sleep(2)
    return False


def main() -> int:
    output: Dict = {
        "base_url": BASE,
        "checks": {},
        "ok": False,
    }
    failures: List[str] = []

    code, admin_login = _json_request(
        "/admin/login",
        method="POST",
        payload={"username": ADMIN_USER, "password": ADMIN_PASS},
    )
    if code != 200:
        output["error"] = "admin_login_failed"
        output["status"] = code
        output["body"] = admin_login
        print(json.dumps(output, indent=2))
        return 1

    admin_token = admin_login.get("token")

    code, employees_data = _json_request("/employees", token=admin_token)
    if code != 200:
        output["error"] = "employees_fetch_failed"
        output["status"] = code
        output["body"] = employees_data
        print(json.dumps(output, indent=2))
        return 1

    employees = employees_data if isinstance(employees_data, list) else (employees_data or {}).get("employees", [])
    user_a, user_b, skip_notes = _pick_test_users(employees)
    output["user_selection"] = {
        "usable_count": 0 if (user_a is None or user_b is None) else 2,
        "notes": skip_notes,
    }
    if not user_a or not user_b:
        failures.append("Need at least 2 users with valid login_id and image files")
        output["checks"]["test_data_ready"] = {"ok": False}
        output["failures"] = failures
        print(json.dumps(output, indent=2))
        return 2

    if bool(user_a.get("must_change_password")):
        failures.append("REGRESSION_USER_LOGIN_ID points to user with must_change_password=true")
        output["checks"]["test_data_ready"] = {"ok": False, "message": "Login test user must have must_change_password=false"}
        output["failures"] = failures
        print(json.dumps(output, indent=2))
        return 2

    if not REG_USER_PASSWORD:
        failures.append("Set REGRESSION_USER_PASSWORD env var for secure regression login")
        output["checks"]["test_data_ready"] = {"ok": False, "message": "Missing REGRESSION_USER_PASSWORD"}
        output["failures"] = failures
        print(json.dumps(output, indent=2))
        return 2

    code, user_login = _json_request(
        "/user/login",
        method="POST",
        payload={
            "login_id": str(user_a.get("login_id") or "").strip().lower(),
            "password": REG_USER_PASSWORD,
        },
    )
    if code != 200:
        output["error"] = "user_login_failed"
        output["status"] = code
        output["body"] = user_login
        print(json.dumps(output, indent=2))
        return 3

    user_token = user_login.get("token")

    code_refresh, refresh_data = _json_request("/auth/refresh_user", method="POST", token=user_token)
    refreshed_token = str((refresh_data or {}).get("token") or "")
    refresh_ok = code_refresh == 200 and bool(refreshed_token) and refreshed_token != user_token
    output["checks"]["session_refresh_rotation"] = {
        "ok": bool(refresh_ok),
        "status_code": code_refresh,
        "token_rotated": bool(refreshed_token and refreshed_token != user_token),
    }
    if not refresh_ok:
        failures.append("session_refresh_rotation")
    else:
        user_token = refreshed_token

    code, token_policy = _json_request("/security/token_policy", token=admin_token)
    policy_user_min = None
    if code == 200:
        policy_user_min = int((token_policy or {}).get("user_expires_min") or 0)

    claims = _decode_jwt_payload(user_token)
    token_minutes = int((claims.get("exp", 0) - claims.get("iat", 0)) / 60)
    min_expected = policy_user_min if policy_user_min and policy_user_min > 0 else 1440
    session_ok = token_minutes >= min_expected and (policy_user_min is None or token_minutes == policy_user_min)
    output["checks"]["user_login_session_expiry"] = {
        "ok": bool(session_ok),
        "token_minutes": token_minutes,
        "expected_min_minutes": min_expected,
        "policy_user_expires_min": policy_user_min,
    }
    if not session_ok:
        failures.append("user_login_session_expiry")

    code, geo_original = _json_request("/geofence_settings", token=admin_token)
    if code != 200:
        output["error"] = "geofence_fetch_failed"
        output["status"] = code
        output["body"] = geo_original
        print(json.dumps(output, indent=2))
        return 4

    code, rec_original = _json_request("/recognition_settings", token=admin_token)
    if code != 200:
        output["error"] = "recognition_settings_fetch_failed"
        output["status"] = code
        output["body"] = rec_original
        print(json.dumps(output, indent=2))
        return 5

    geo_old = dict(geo_original or {})
    rec_old = dict(rec_original or {})

    test_lat = float(geo_old.get("office_lat") if geo_old.get("office_lat") is not None else 28.6139)
    test_lng = float(geo_old.get("office_lng") if geo_old.get("office_lng") is not None else 77.2090)
    test_radius = float(geo_old.get("office_radius_meters") or 120.0)

    try:
        # geofence OFF block
        _json_request(
            "/geofence_settings",
            method="PUT",
            payload={
                "enabled": False,
                "office_lat": geo_old.get("office_lat"),
                "office_lng": geo_old.get("office_lng"),
                "office_radius_meters": geo_old.get("office_radius_meters") or 120,
            },
            token=admin_token,
        )
        code, scan_off = _json_request("/scan_attendance", method="POST", payload={}, token=user_token)
        geofence_off_ok = code == 403 and str((scan_off or {}).get("status") or "") == "geofence_disabled"
        output["checks"]["geofence_off_block"] = {
            "ok": bool(geofence_off_ok),
            "status_code": code,
            "status": (scan_off or {}).get("status"),
            "message": (scan_off or {}).get("message"),
        }
        if not geofence_off_ok:
            failures.append("geofence_off_block")

        # geofence ON + changed office location
        _json_request(
            "/geofence_settings",
            method="PUT",
            payload={
                "enabled": True,
                "office_lat": test_lat,
                "office_lng": test_lng,
                "office_radius_meters": test_radius,
            },
            token=admin_token,
        )

        code_in, scan_in = _form_request(
            "/scan_attendance",
            fields={"lat": str(test_lat), "lng": str(test_lng), "accuracy": "5"},
            token=user_token,
        )
        # Expect image-required only after location validation passed.
        in_ok = code_in == 400 and str((scan_in or {}).get("message") or "").lower().find("image file is required") >= 0

        far_lat = test_lat + 3.0
        far_lng = test_lng + 3.0
        code_out, scan_out = _form_request(
            "/scan_attendance",
            fields={"lat": str(far_lat), "lng": str(far_lng), "accuracy": "0"},
            token=user_token,
        )
        out_ok = code_out == 403 and str((scan_out or {}).get("status") or "") == "outside_office"

        geo_changed_ok = in_ok and out_ok
        output["checks"]["geofence_on_changed_location"] = {
            "ok": bool(geo_changed_ok),
            "inside_probe": {
                "status_code": code_in,
                "status": (scan_in or {}).get("status"),
                "message": (scan_in or {}).get("message"),
            },
            "outside_probe": {
                "status_code": code_out,
                "status": (scan_out or {}).get("status"),
                "message": (scan_out or {}).get("message"),
            },
            "office": {
                "lat": test_lat,
                "lng": test_lng,
                "radius_m": test_radius,
            },
        }
        if not geo_changed_ok:
            failures.append("geofence_on_changed_location")

        # Face mismatch rejection
        _json_request(
            "/recognition_settings",
            method="PUT",
            payload={"enable_liveness": False, "scan_require_blink": False},
            token=admin_token,
        )

        wrong_image = pathlib.Path(str(user_b.get("_test_image")))
        mismatch_fields = {
            "lat": str(test_lat),
            "lng": str(test_lng),
            "accuracy": "5",
        }

        code_mm, body_mm = _multipart_request("/scan_attendance", wrong_image, mismatch_fields, user_token)

        if code_mm == 409 and str((body_mm or {}).get("status") or "") == "model_not_ready":
            _json_request("/train_model", method="POST", token=admin_token)
            _wait_for_training(admin_token)
            code_mm, body_mm = _multipart_request("/scan_attendance", wrong_image, mismatch_fields, user_token)

        mismatch_ok = (
            code_mm == 422
            and "not matching" in str((body_mm or {}).get("message") or "").lower()
        )
        output["checks"]["face_mismatch_rejection"] = {
            "ok": bool(mismatch_ok),
            "status_code": code_mm,
            "status": (body_mm or {}).get("status"),
            "message": (body_mm or {}).get("message"),
            "logged_in_user": {
                "name": user_a.get("name"),
                "login_id": user_a.get("login_id"),
            },
            "wrong_image_user": {
                "name": user_b.get("name"),
                "login_id": user_b.get("login_id"),
                "image": str(wrong_image),
            },
        }
        if not mismatch_ok:
            failures.append("face_mismatch_rejection")

    finally:
        _json_request(
            "/recognition_settings",
            method="PUT",
            payload={
                "enable_liveness": bool(rec_old.get("enable_liveness", True)),
                "scan_require_blink": bool(rec_old.get("scan_require_blink", False)),
            },
            token=admin_token,
        )

        _json_request(
            "/geofence_settings",
            method="PUT",
            payload={
                "enabled": bool(geo_old.get("enabled", True)),
                "office_lat": geo_old.get("office_lat"),
                "office_lng": geo_old.get("office_lng"),
                "office_radius_meters": float(geo_old.get("office_radius_meters") or 120.0),
            },
            token=admin_token,
        )

    output["ok"] = len(failures) == 0
    output["failures"] = failures
    print(json.dumps(output, indent=2))
    return 0 if output["ok"] else 10


if __name__ == "__main__":
    raise SystemExit(main())
