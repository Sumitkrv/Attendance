import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:5001"


def req(path, method="GET", payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    r = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw or "{}")
        except Exception:
            data = {"raw": raw[:500]}
        return int(e.code), data


def main():
    s, admin = req("/admin/login", method="POST", payload={"username": "admin", "password": "admin123"})
    if s != 200:
        raise SystemExit(f"admin login failed: {s} {admin}")
    admin_token = admin.get("token")

    s, geo = req("/geofence_settings", token=admin_token)
    if s != 200:
        raise SystemExit(f"geofence read failed: {s} {geo}")
    old = dict(geo)

    # disable geofence
    req(
        "/geofence_settings",
        method="PUT",
        payload={
            "enabled": False,
            "office_lat": old.get("office_lat"),
            "office_lng": old.get("office_lng"),
            "office_radius_meters": old.get("office_radius_meters"),
        },
        token=admin_token,
    )

    # get sumit login details
    s, employees = req("/employees", token=admin_token)
    rows = employees if isinstance(employees, list) else employees.get("employees", [])
    sumit = next((x for x in rows if str(x.get("name", "")).lower() == "sumit"), None)
    if not sumit:
        raise SystemExit("sumit user not found")

    login_id = sumit.get("login_id")
    password = sumit.get("password_visible_for_admin")
    if not password:
        raise SystemExit("sumit password visible field is blank; cannot auto-login test")

    s, user = req("/user/login", method="POST", payload={"login_id": login_id, "password": password})
    if s != 200:
        raise SystemExit(f"user login failed: {s} {user}")
    user_token = user.get("token")

    # no image provided intentionally; geofence-disabled guard should fire first
    s, scan = req("/scan_attendance", method="POST", payload={}, token=user_token)

    # restore geofence
    req(
        "/geofence_settings",
        method="PUT",
        payload={
            "enabled": bool(old.get("enabled")),
            "office_lat": old.get("office_lat"),
            "office_lng": old.get("office_lng"),
            "office_radius_meters": old.get("office_radius_meters"),
        },
        token=admin_token,
    )

    print(json.dumps({"scan_status_code": s, "scan_response": scan}, indent=2))


if __name__ == "__main__":
    main()
