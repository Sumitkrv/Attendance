import json
import mimetypes
import pathlib
import time
import urllib.error
import urllib.request
import uuid
from typing import Optional

BASE = "http://127.0.0.1:5001"
ADMIN_USER = "admin"
ADMIN_PASS = "admin123"
TARGET_PASS = "Pass@1234"
TARGET_PASS_AFTER_CHANGE = "Pass@12345"


def _json_request(path: str, method: str = "GET", payload: Optional[dict] = None, token: Optional[str] = None, timeout: int = 15):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            data = json.loads(text or "{}")
            return resp.status, data
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(text or "{}")
        except Exception:
            data = {"raw": text[:500]}
        return int(e.code), data


def _multipart_request(path: str, file_path: pathlib.Path, fields: dict[str, str], token: str, timeout: int = 30):
    boundary = f"----fa{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    def add_line(line: str):
        chunks.append(line.encode("utf-8"))
        chunks.append(b"\r\n")

    for k, v in (fields or {}).items():
        add_line(f"--{boundary}")
        add_line(f'Content-Disposition: form-data; name="{k}"')
        add_line("")
        add_line(str(v))

    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    add_line(f"--{boundary}")
    add_line(f'Content-Disposition: form-data; name="image"; filename="{file_path.name}"')
    add_line(f"Content-Type: {content_type}")
    add_line("")
    chunks.append(file_path.read_bytes())
    chunks.append(b"\r\n")
    add_line(f"--{boundary}--")

    body = b"".join(chunks)
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Authorization": f"Bearer {token}",
    }
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            data = json.loads(text or "{}")
            return resp.status, data
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(text or "{}")
        except Exception:
            data = {"raw": text[:500]}
        return int(e.code), data


def main() -> int:
    code, login_data = _json_request("/admin/login", method="POST", payload={"username": ADMIN_USER, "password": ADMIN_PASS})
    if code != 200:
        print(json.dumps({"ok": False, "error": "admin_login_failed", "status": code, "body": login_data}, indent=2))
        return 1
    admin_token = login_data.get("token")

    code, employees_data = _json_request("/employees", method="GET", token=admin_token)
    if code != 200:
        print(json.dumps({"ok": False, "error": "employees_fetch_failed", "status": code, "body": employees_data}, indent=2))
        return 1
    if isinstance(employees_data, list):
        employees = employees_data
    else:
        employees = (employees_data or {}).get("employees", [])
    by_name = {str(x.get("name", "")).strip().lower(): x for x in employees}

    required = ("verma", "sumit")
    missing = [x for x in required if x not in by_name]
    if missing:
        print(json.dumps({"ok": False, "error": "missing_users", "missing": missing, "found": [e.get("name") for e in employees]}, indent=2))
        return 2

    for nm in required:
        emp_id = by_name[nm]["id"]
        code, payload = _json_request(
            f"/employees/{emp_id}/reset_password",
            method="POST",
            payload={"new_password": TARGET_PASS},
            token=admin_token,
        )
        if code not in (200, 201):
            print(json.dumps({"ok": False, "error": "password_reset_failed", "user": nm, "status": code, "body": payload}, indent=2))
            return 3

    code, geodata = _json_request("/geofence_settings", method="GET", token=admin_token)
    if code != 200:
        print(json.dumps({"ok": False, "error": "geofence_fetch_failed", "status": code, "body": geodata}, indent=2))
        return 5
    geodata = geodata or {}
    if isinstance(geodata, dict) and "geofence" in geodata and isinstance(geodata.get("geofence"), dict):
        geodata = geodata.get("geofence") or {}
    lat = str(geodata.get("office_lat") or "")
    lng = str(geodata.get("office_lng") or "")

    code, rec_data = _json_request("/recognition_settings", method="GET", token=admin_token)
    if code != 200:
        print(json.dumps({"ok": False, "error": "recognition_settings_fetch_failed", "status": code, "body": rec_data}, indent=2))
        return 7
    rec_settings = rec_data if isinstance(rec_data, dict) else {}
    original_enable_liveness = bool(rec_settings.get("enable_liveness", True))
    original_scan_require_blink = bool(rec_settings.get("scan_require_blink", False))

    code, rec_update = _json_request(
        "/recognition_settings",
        method="PUT",
        payload={"enable_liveness": False, "scan_require_blink": False},
        token=admin_token,
    )
    if code != 200:
        print(json.dumps({"ok": False, "error": "recognition_settings_update_failed", "status": code, "body": rec_update}, indent=2))
        return 8

    verma_login_id = str(by_name["verma"].get("login_id") or "verma").strip().lower()
    code, u_data = _json_request("/user/login", method="POST", payload={"login_id": verma_login_id, "password": TARGET_PASS})
    if code != 200:
        print(json.dumps({"ok": False, "error": "user_login_failed", "status": code, "body": u_data}, indent=2))
        return 4
    user_token = u_data.get("token")
    must_change = bool((u_data.get("employee") or {}).get("must_change_password"))
    if must_change:
        code, cp_data = _json_request(
            "/user/change_password",
            method="POST",
            payload={"current_password": TARGET_PASS, "new_password": TARGET_PASS_AFTER_CHANGE},
            token=user_token,
        )
        if code != 200:
            print(json.dumps({"ok": False, "error": "user_change_password_failed", "status": code, "body": cp_data}, indent=2))
            return 6
        user_token = cp_data.get("token") or user_token

    sumit_img = pathlib.Path("/Users/sumitthakur/Desktop/Attendance/face-attendance-system/persistent/dataset/sumit/capture_01.jpg")
    verma_img = pathlib.Path("/Users/sumitthakur/Desktop/Attendance/face-attendance-system/persistent/dataset/verma/capture_01.jpg")

    def scan(img_path: pathlib.Path):
        form_data = {}
        if lat and lng:
            form_data.update({"lat": lat, "lng": lng, "accuracy": "15"})
        t0 = time.perf_counter()
        code, payload = _multipart_request("/scan_attendance", img_path, form_data, user_token)
        elapsed = time.perf_counter() - t0
        return {
            "status_code": code,
            "time_sec": round(elapsed, 3),
            "status": payload.get("status"),
            "message": payload.get("message"),
        }

    try:
        result = {
            "ok": True,
            "verma_login": "ok",
            "sumit_image_attempt": scan(sumit_img),
            "verma_image_attempt": scan(verma_img),
        }
        print(json.dumps(result, indent=2))
        return 0
    finally:
        _json_request(
            "/recognition_settings",
            method="PUT",
            payload={
                "enable_liveness": original_enable_liveness,
                "scan_require_blink": original_scan_require_blink,
            },
            token=admin_token,
        )


if __name__ == "__main__":
    raise SystemExit(main())
