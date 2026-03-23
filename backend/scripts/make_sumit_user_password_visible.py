import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:5001"
TEMP_PASSWORD = "Sumi@12345"
USER_NEW_PASSWORD = "Sumi@123456"


def req(path, method="GET", payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=15) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(text or "{}")
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(text or "{}")
        except Exception:
            data = {"raw": text[:500]}
        return int(e.code), data


def main():
    code, admin = req("/admin/login", method="POST", payload={"username": "admin", "password": "admin123"})
    if code != 200:
        raise SystemExit(f"Admin login failed: {code} {admin}")
    admin_token = admin.get("token")

    code, emp_data = req("/employees", token=admin_token)
    if code != 200:
        raise SystemExit(f"Employees fetch failed: {code} {emp_data}")
    employees = emp_data if isinstance(emp_data, list) else emp_data.get("employees", [])
    sumit = next((e for e in employees if str(e.get("name", "")).strip().lower() == "sumit"), None)
    if not sumit:
        raise SystemExit("Sumit employee not found")

    employee_id = sumit.get("id")
    login_id = sumit.get("login_id")

    # Step 1: admin reset to known password
    code, reset_data = req(
        f"/employees/{employee_id}/reset_password",
        method="POST",
        payload={"new_password": TEMP_PASSWORD},
        token=admin_token,
    )
    if code != 200:
        raise SystemExit(f"Reset failed: {code} {reset_data}")

    # Step 2: user login
    code, login_data = req(
        "/user/login",
        method="POST",
        payload={"login_id": login_id, "password": TEMP_PASSWORD},
    )
    if code != 200:
        raise SystemExit(f"User login failed: {code} {login_data}")
    user_token = login_data.get("token")

    # Step 3: user changes password (this should make it visible as user-updated)
    code, change_data = req(
        "/user/change_password",
        method="POST",
        payload={"current_password": TEMP_PASSWORD, "new_password": USER_NEW_PASSWORD},
        token=user_token,
    )
    if code != 200:
        raise SystemExit(f"Password change failed: {code} {change_data}")

    # Step 4: verify admin sees it
    code, emp_data2 = req("/employees", token=admin_token)
    employees2 = emp_data2 if isinstance(emp_data2, list) else emp_data2.get("employees", [])
    sumit2 = next((e for e in employees2 if str(e.get("name", "")).strip().lower() == "sumit"), {})

    print(
        json.dumps(
            {
                "name": sumit2.get("name"),
                "login_id": sumit2.get("login_id"),
                "password_visible_for_admin": sumit2.get("password_visible_for_admin"),
                "password_updated_by": sumit2.get("password_updated_by"),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
