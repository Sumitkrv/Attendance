import json
import urllib.request

BASE = "http://127.0.0.1:5001"


def req(path, method="GET", payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=15) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        return resp.status, json.loads(body or "{}")


_, admin = req("/admin/login", method="POST", payload={"username": "admin", "password": "admin123"})
token = admin["token"]
_, emps_data = req("/employees", token=token)
emps = emps_data if isinstance(emps_data, list) else emps_data.get("employees", [])
sumit = next(e for e in emps if str(e.get("name", "")).lower() == "sumit")

new_password = "Sumi@12345"
reset_status, _ = req(
    f"/employees/{sumit['id']}/reset_password",
    method="POST",
    payload={"new_password": new_password},
    token=token,
)
_, emps_data2 = req("/employees", token=token)
emps2 = emps_data2 if isinstance(emps_data2, list) else emps_data2.get("employees", [])
sumit2 = next(e for e in emps2 if str(e.get("name", "")).lower() == "sumit")

print(json.dumps({
    "reset_status": reset_status,
    "sumit_after_reset": {
        "login_id": sumit2.get("login_id"),
        "password_visible_for_admin": sumit2.get("password_visible_for_admin"),
        "password_updated_by": sumit2.get("password_updated_by"),
    }
}, indent=2))
