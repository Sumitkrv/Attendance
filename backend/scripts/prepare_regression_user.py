import json
import urllib.request

BASE = "http://127.0.0.1:5001"
ADMIN_USER = "admin"
ADMIN_PASS = "admin123"
LOGIN_ID = "ver"
TEMP_PASSWORD = "TempVerA123!"
FINAL_PASSWORD = "VermaFinalA123!"


def req(path, method="GET", payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=20) as response:
        data = json.loads(response.read().decode("utf-8") or "{}")
        return int(response.status), data


status, admin = req(
    "/admin/login",
    method="POST",
    payload={"username": ADMIN_USER, "password": ADMIN_PASS},
)
assert status == 200 and admin.get("token"), "admin login failed"
admin_token = admin["token"]

_, employees_data = req("/employees", token=admin_token)
employees = employees_data if isinstance(employees_data, list) else employees_data.get("employees", [])
user = next((e for e in employees if str(e.get("login_id") or "").strip().lower() == LOGIN_ID), None)
assert user, f"employee login_id={LOGIN_ID} not found"

employee_id = str(user.get("id") or "")
assert employee_id, "employee id missing"

reset_status, _ = req(
    f"/employees/{employee_id}/reset_password",
    method="POST",
    payload={"new_password": TEMP_PASSWORD},
    token=admin_token,
)

login_temp_status, login_temp = req(
    "/user/login",
    method="POST",
    payload={"login_id": LOGIN_ID, "password": TEMP_PASSWORD},
)
user_token = login_temp.get("token")
assert login_temp_status == 200 and user_token, "temp user login failed"

change_status, _ = req(
    "/user/change_password",
    method="POST",
    payload={"current_password": TEMP_PASSWORD, "new_password": FINAL_PASSWORD},
    token=user_token,
)

login_final_status, login_final = req(
    "/user/login",
    method="POST",
    payload={"login_id": LOGIN_ID, "password": FINAL_PASSWORD},
)

print(
    json.dumps(
        {
            "login_id": LOGIN_ID,
            "reset_status": reset_status,
            "temp_login_status": login_temp_status,
            "change_password_status": change_status,
            "final_login_status": login_final_status,
            "must_change_password_after_final_login": (login_final.get("employee") or {}).get("must_change_password"),
            "regression_password": FINAL_PASSWORD,
        },
        indent=2,
    )
)
