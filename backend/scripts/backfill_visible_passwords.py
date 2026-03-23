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
    request = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw or "{}")
        except Exception:
            data = {"raw": raw[:500]}
        return int(e.code), data


def make_temp_password(login_id: str) -> str:
    value = "".join(ch for ch in str(login_id or "user") if ch.isalnum())
    value = value or "user"
    return value.capitalize() + "@12345"


def main() -> int:
    code, admin = req("/admin/login", method="POST", payload={"username": "admin", "password": "admin123"})
    if code != 200:
        print(json.dumps({"ok": False, "error": "admin_login_failed", "status": code, "body": admin}, indent=2))
        return 1
    token = admin.get("token")

    code, employees_data = req("/employees", token=token)
    if code != 200:
        print(json.dumps({"ok": False, "error": "employees_fetch_failed", "status": code, "body": employees_data}, indent=2))
        return 2

    employees = employees_data if isinstance(employees_data, list) else employees_data.get("employees", [])

    updated = []
    for row in employees:
        visible = str(row.get("password_visible_for_admin") or "").strip()
        if visible:
            continue
        emp_id = str(row.get("id") or "")
        login_id = str(row.get("login_id") or "")
        temp_password = make_temp_password(login_id)

        r_code, r_data = req(
            f"/employees/{emp_id}/reset_password",
            method="POST",
            payload={"new_password": temp_password},
            token=token,
        )
        if r_code != 200:
            updated.append(
                {
                    "name": row.get("name"),
                    "login_id": login_id,
                    "status": "failed",
                    "error": r_data,
                }
            )
            continue

        updated.append(
            {
                "name": row.get("name"),
                "login_id": login_id,
                "status": "updated",
                "temporary_password": temp_password,
            }
        )

    code, final_data = req("/employees", token=token)
    final_rows = final_data if isinstance(final_data, list) else final_data.get("employees", [])

    print(
        json.dumps(
            {
                "ok": True,
                "updated_count": len([x for x in updated if x.get("status") == "updated"]),
                "updated": updated,
                "final": [
                    {
                        "name": x.get("name"),
                        "login_id": x.get("login_id"),
                        "password_visible_for_admin": x.get("password_visible_for_admin"),
                    }
                    for x in final_rows
                ],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
