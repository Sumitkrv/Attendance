import json
import urllib.request

BASE = "http://127.0.0.1:5001"
NEW_PASSWORD = "Verma@1234"


def req(path, method="GET", payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
    request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=10) as resp:
        body = resp.read().decode()
        return resp.status, json.loads(body or "{}")


status, admin = req("/admin/login", method="POST", payload={"username": "admin", "password": "admin123"})
token = admin["token"]

_, employees_data = req("/employees", token=token)
employees = employees_data if isinstance(employees_data, list) else employees_data.get("employees", [])
verma = next((e for e in employees if str(e.get("login_id", "")).lower() == "verma"), None)
if not verma:
    raise SystemExit("employee login_id=verma not found")

reset_status, _ = req(
    f"/employees/{verma['id']}/reset_password",
    method="POST",
    payload={"new_password": NEW_PASSWORD},
    token=token,
)

login_status, login_data = req(
    "/user/login",
    method="POST",
    payload={"login_id": "verma", "password": NEW_PASSWORD},
)

print(
    json.dumps(
        {
            "reset_status": reset_status,
            "user_login_status": login_status,
            "success": login_data.get("success"),
            "must_change_password": (login_data.get("employee") or {}).get("must_change_password"),
        },
        indent=2,
    )
)
