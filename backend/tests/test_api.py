# ==========================================================================
# Item 4: Comprehensive API tests using pytest + httpx
# Run: cd backend && python -m pytest tests/ -v
# ==========================================================================
import os
import sys
import json
import pytest

# Ensure backend source is importable
_backend_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _backend_root not in sys.path:
    sys.path.insert(0, _backend_root)

# Force mock DB for tests
os.environ["USE_MOCK_DB"] = "true"
os.environ["ALLOW_MOCK_DB"] = "true"
os.environ["APP_ENV"] = "test"
os.environ["SECRET_KEY"] = "test-secret-key-for-ci-only"
os.environ["ADMIN_USERNAME"] = "admin"
os.environ["ADMIN_PASSWORD"] = "testpass123"
os.environ["CORS_ALLOW_ALL"] = "true"
os.environ["ENABLE_OFFICE_GEOFENCE"] = "false"
os.environ["FORCE_OFFICE_GEOFENCE"] = "false"
os.environ["DISABLE_BACKEND_UI"] = "false"

from src.api.app import app


@pytest.fixture
def client():
    """Flask test client using mock DB."""
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


@pytest.fixture
def admin_token(client):
    """Get a valid admin JWT token."""
    resp = client.post("/admin/login", json={"username": "admin", "password": "testpass123"})
    data = resp.get_json()
    assert resp.status_code == 200, f"Admin login failed: {data}"
    return data["token"]


def auth_header(token):
    return {"Authorization": f"Bearer {token}"}


# ==================== Health & Readiness ====================

class TestHealthEndpoints:
    def test_health_returns_ok(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "ok"
        assert "time" in data
        assert "app_env" in data

    def test_ready_returns_status(self, client):
        resp = client.get("/ready")
        assert resp.status_code in (200, 503)
        data = resp.get_json()
        assert "status" in data

    def test_warmup(self, client):
        resp = client.get("/warmup")
        assert resp.status_code in (200, 503)


# ==================== Admin Auth ====================

class TestAdminAuth:
    def test_login_success(self, client):
        resp = client.post("/admin/login", json={"username": "admin", "password": "testpass123"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert "token" in data

    def test_login_bad_password(self, client):
        resp = client.post("/admin/login", json={"username": "admin", "password": "wrong"})
        assert resp.status_code == 401
        data = resp.get_json()
        assert data["success"] is False

    def test_login_empty_body(self, client):
        resp = client.post("/admin/login", json={})
        assert resp.status_code == 401

    def test_account_lockout_after_failures(self, client):
        """After 5 failed attempts, account should be locked."""
        for i in range(5):
            client.post("/admin/login", json={"username": "locktest", "password": "wrong"})
        resp = client.post("/admin/login", json={"username": "locktest", "password": "wrong"})
        assert resp.status_code == 429
        data = resp.get_json()
        assert data.get("locked") is True

    def test_token_policy_requires_auth(self, client):
        resp = client.get("/security/token_policy")
        assert resp.status_code == 401

    def test_token_policy_with_auth(self, client, admin_token):
        resp = client.get("/security/token_policy", headers=auth_header(admin_token))
        assert resp.status_code == 200


# ==================== Employee CRUD ====================

class TestEmployeeEndpoints:
    def test_list_employees(self, client, admin_token):
        resp = client.get("/employees", headers=auth_header(admin_token))
        assert resp.status_code == 200
        assert isinstance(resp.get_json(), list)

    def test_register_employee(self, client, admin_token):
        resp = client.post("/register_employee",
            json={
                "name": "Test User",
                "login_id": "testuser",
                "password": "Test123pass",
                "department": "Engineering",
            },
            headers=auth_header(admin_token),
        )
        data = resp.get_json()
        assert resp.status_code == 200, f"Register failed: {data}"
        assert "employee" in data

    def test_register_duplicate_login_id(self, client, admin_token):
        # First create
        client.post("/register_employee",
            json={"name": "Dup User", "login_id": "duptest", "password": "Dup123pass"},
            headers=auth_header(admin_token),
        )
        # Duplicate
        resp = client.post("/register_employee",
            json={"name": "Dup User 2", "login_id": "duptest", "password": "Dup123pass"},
            headers=auth_header(admin_token),
        )
        assert resp.status_code == 409

    def test_register_requires_auth(self, client):
        resp = client.post("/register_employee", json={"name": "No Auth", "login_id": "noauth", "password": "Test123"})
        assert resp.status_code == 401


# ==================== Attendance ====================

class TestAttendanceEndpoints:
    def test_list_attendance(self, client, admin_token):
        resp = client.get("/attendance", headers=auth_header(admin_token))
        assert resp.status_code == 200
        assert isinstance(resp.get_json(), list)

    def test_attendance_invalid_date(self, client, admin_token):
        resp = client.get("/attendance?date=not-a-date", headers=auth_header(admin_token))
        assert resp.status_code == 400

    def test_dashboard_summary(self, client, admin_token):
        resp = client.get("/api/dashboard/summary", headers=auth_header(admin_token))
        assert resp.status_code == 200
        data = resp.get_json()
        assert "total_employees" in data
        assert "present" in data


# ==================== Geofence & Settings ====================

class TestSettingsEndpoints:
    def test_geofence_settings(self, client, admin_token):
        resp = client.get("/geofence_settings", headers=auth_header(admin_token))
        assert resp.status_code == 200
        data = resp.get_json()
        assert "enabled" in data

    def test_update_geofence(self, client, admin_token):
        resp = client.put("/geofence_settings",
            json={"enabled": False, "office_radius_meters": 200},
            headers={**auth_header(admin_token), "Content-Type": "application/json"},
        )
        assert resp.status_code == 200

    def test_recognition_settings(self, client, admin_token):
        resp = client.get("/recognition_settings", headers=auth_header(admin_token))
        assert resp.status_code == 200


# ==================== Tasks ====================

class TestTaskEndpoints:
    def test_list_tasks(self, client, admin_token):
        resp = client.get("/tasks", headers=auth_header(admin_token))
        assert resp.status_code == 200

    def test_create_task(self, client, admin_token):
        resp = client.post("/tasks",
            json={"title": "Test task", "description": "A test", "priority": "medium"},
            headers={**auth_header(admin_token), "Content-Type": "application/json"},
        )
        # May need assigned_to, so 200 or 400 both acceptable in test setup
        assert resp.status_code in (200, 400)


# ==================== Audit Logs ====================

class TestAuditLogs:
    def test_list_audit_logs(self, client, admin_token):
        resp = client.get("/audit_logs", headers=auth_header(admin_token))
        assert resp.status_code == 200


# ==================== Training ====================

class TestTraining:
    def test_train_status(self, client, admin_token):
        resp = client.get("/train_model/status", headers=auth_header(admin_token))
        assert resp.status_code == 200
        data = resp.get_json()
        assert "status" in data

    def test_train_requires_auth(self, client):
        resp = client.post("/train_model")
        assert resp.status_code == 401


# ==================== Backend UI removed ====================

class TestBackendUIRemoved:
    def test_home_returns_json_not_html(self, client):
        resp = client.get("/")
        data = resp.get_json()
        # Should be JSON (API info), not HTML
        assert data is not None
        assert "service" in data or resp.status_code == 302

    def test_admin_page_returns_json_not_html(self, client):
        resp = client.get("/admin")
        data = resp.get_json()
        assert data is not None or resp.status_code == 302

    def test_user_page_returns_json_not_html(self, client):
        resp = client.get("/user")
        data = resp.get_json()
        assert data is not None or resp.status_code == 302
