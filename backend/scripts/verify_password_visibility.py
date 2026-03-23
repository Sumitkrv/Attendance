import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:5001"
TEMP_PASSWORD = "Verma@1234"
USER_NEW_PASSWORD = "Verma@12345"


def req(path, method="GET", payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(body or "{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(body or "{}")
        except Exception:
            payload = {"raw": body}
        return int(e.code), payload


# Admin login
_, admin = req("/admin/login", method="POST", payload={"username": "admin", "password": "admin123"})
admin_token = admin["token"]

# Get verma account details
_, emps_data = req("/employees", token=admin_token)
emps = emps_data if isinstance(emps_data, list) else emps_data.get("employees", [])
verma = next((e for e in emps if str(e.get("name", "")).strip().lower() == "verma"), None)
if not verma:
    raise SystemExit("Verma employee not found")
login_id = verma.get("login_id")

# Reset password as admin so test starts from known state
reset_status, reset_payload = req(
    f"/employees/{verma.get('id')}/reset_password",
    method="POST",
    payload={"new_password": TEMP_PASSWORD},
    token=admin_token,
)
if reset_status != 200:
    raise SystemExit(f"Unable to reset verma password. status={reset_status} body={reset_payload}")

# Try user login with temp password
status, login = req("/user/login", method="POST", payload={"login_id": login_id, "password": TEMP_PASSWORD})
if status != 200:
    raise SystemExit(f"Unable to login as verma using temp password. status={status} body={login}")
user_token = login.get("token")

# Change password as user
status, changed = req(
    "/user/change_password",
    method="POST",
    payload={"current_password": TEMP_PASSWORD, "new_password": USER_NEW_PASSWORD},
    token=user_token,
)
if status != 200:
    raise SystemExit(f"Unable to change verma password as user. status={status} body={changed}")

# Fetch employee list again and print password-visible field
_, emps2_data = req("/employees", token=admin_token)
emps2 = emps2_data if isinstance(emps2_data, list) else emps2_data.get("employees", [])
verma2 = next((e for e in emps2 if str(e.get("name", "")).strip().lower() == "verma"), {})

print(json.dumps({
    "login_id": verma2.get("login_id"),
    "password_visible_for_admin": verma2.get("password_visible_for_admin"),
    "password_updated_by": verma2.get("password_updated_by"),
}, indent=2))
