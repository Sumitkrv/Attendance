# ==========================================================================
# Item 8: OpenAPI/Swagger documentation
# Access at: GET /api/docs (JSON) or use Swagger UI at /api/docs/ui
# ==========================================================================
from flask import Blueprint, jsonify

api_docs_bp = Blueprint("api_docs", __name__)

OPENAPI_SPEC = {
    "openapi": "3.0.3",
    "info": {
        "title": "HRMS Face Recognition Attendance API",
        "description": "Production-ready API for face-recognition-based attendance management with geofence, liveness detection, task management, and employee lifecycle operations.",
        "version": "1.0.0",
        "contact": {"name": "PRHR Support", "email": "support@prsparkz.com"},
    },
    "servers": [
        {"url": "http://localhost:5001", "description": "Local Development"},
    ],
    "tags": [
        {"name": "Health", "description": "Server health and readiness checks"},
        {"name": "Auth", "description": "Admin and user authentication"},
        {"name": "Employees", "description": "Employee CRUD and management"},
        {"name": "Attendance", "description": "Attendance marking, scanning, and history"},
        {"name": "Tasks", "description": "Task assignment and tracking"},
        {"name": "Leave", "description": "Leave request management"},
        {"name": "Settings", "description": "Geofence, recognition, and system settings"},
        {"name": "Reports", "description": "Analytics and reporting"},
        {"name": "Notifications", "description": "In-app notifications"},
        {"name": "Assets", "description": "Employee document and file management"},
        {"name": "Training", "description": "Face model training"},
        {"name": "Account", "description": "Admin account and session management"},
        {"name": "Warnings", "description": "Employee warning system"},
    ],
    "components": {
        "securitySchemes": {
            "BearerAuth": {
                "type": "http",
                "scheme": "bearer",
                "bearerFormat": "JWT",
                "description": "JWT token from /admin/login or /user/login",
            }
        },
        "schemas": {
            "Employee": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "name": {"type": "string"},
                    "login_id": {"type": "string"},
                    "department": {"type": "string", "default": "General"},
                    "status": {"type": "string", "enum": ["active", "inactive", "exited"]},
                    "must_change_password": {"type": "boolean"},
                },
            },
            "AttendanceRecord": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "employee_id": {"type": "string"},
                    "employee_name": {"type": "string"},
                    "date": {"type": "string", "format": "date"},
                    "status": {"type": "string", "enum": ["checked_in", "checked_out", "absent", "leave"]},
                    "check_in": {"type": "string", "nullable": True},
                    "check_out": {"type": "string", "nullable": True},
                    "timing_status": {"type": "string"},
                },
            },
            "Task": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "status": {"type": "string", "enum": ["pending", "in_progress", "completed", "approved"]},
                    "priority": {"type": "string", "enum": ["low", "medium", "high", "urgent"]},
                    "assigned_to": {"type": "string"},
                    "deadline": {"type": "string", "format": "date-time"},
                },
            },
            "PaginatedResponse": {
                "type": "object",
                "properties": {
                    "items": {"type": "array"},
                    "total": {"type": "integer"},
                    "page": {"type": "integer"},
                    "per_page": {"type": "integer"},
                    "total_pages": {"type": "integer"},
                },
            },
            "Error": {
                "type": "object",
                "properties": {
                    "message": {"type": "string"},
                    "error": {"type": "string"},
                },
            },
        },
    },
    "paths": {
        "/health": {
            "get": {
                "tags": ["Health"],
                "summary": "Health check",
                "responses": {"200": {"description": "Server is healthy"}},
            }
        },
        "/ready": {
            "get": {
                "tags": ["Health"],
                "summary": "Readiness check (database + Redis)",
                "responses": {
                    "200": {"description": "All dependencies ready"},
                    "503": {"description": "One or more dependencies unavailable"},
                },
            }
        },
        "/admin/login": {
            "post": {
                "tags": ["Auth"],
                "summary": "Admin login",
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "username": {"type": "string"},
                                    "password": {"type": "string"},
                                },
                                "required": ["username", "password"],
                            }
                        }
                    },
                },
                "responses": {
                    "200": {"description": "Login successful, JWT token returned"},
                    "401": {"description": "Invalid credentials"},
                    "429": {"description": "Account locked due to failed attempts"},
                },
            }
        },
        "/user/login": {
            "post": {
                "tags": ["Auth"],
                "summary": "Employee login",
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "login_id": {"type": "string"},
                                    "password": {"type": "string"},
                                },
                                "required": ["login_id", "password"],
                            }
                        }
                    },
                },
                "responses": {
                    "200": {"description": "Login successful"},
                    "401": {"description": "Invalid credentials"},
                    "429": {"description": "Account locked"},
                },
            }
        },
        "/employees": {
            "get": {
                "tags": ["Employees"],
                "summary": "List all employees",
                "security": [{"BearerAuth": []}],
                "parameters": [
                    {"name": "page", "in": "query", "schema": {"type": "integer", "default": 1}},
                    {"name": "per_page", "in": "query", "schema": {"type": "integer", "default": 50}},
                ],
                "responses": {"200": {"description": "Employee list"}},
            }
        },
        "/register_employee": {
            "post": {
                "tags": ["Employees"],
                "summary": "Register a new employee",
                "security": [{"BearerAuth": []}],
                "responses": {
                    "200": {"description": "Employee created"},
                    "400": {"description": "Validation error"},
                    "409": {"description": "Duplicate login_id"},
                },
            }
        },
        "/attendance": {
            "get": {
                "tags": ["Attendance"],
                "summary": "List attendance records",
                "security": [{"BearerAuth": []}],
                "parameters": [
                    {"name": "date", "in": "query", "schema": {"type": "string", "format": "date"}},
                    {"name": "page", "in": "query", "schema": {"type": "integer", "default": 1}},
                    {"name": "per_page", "in": "query", "schema": {"type": "integer", "default": 100}},
                ],
                "responses": {"200": {"description": "Attendance records"}},
            }
        },
        "/scan_attendance": {
            "post": {
                "tags": ["Attendance"],
                "summary": "Scan face for attendance (requires user token + location)",
                "security": [{"BearerAuth": []}],
                "responses": {
                    "200": {"description": "Face recognized, attendance marked"},
                    "400": {"description": "Invalid image or missing data"},
                    "403": {"description": "Geofence/location error"},
                },
            }
        },
        "/tasks": {
            "get": {
                "tags": ["Tasks"],
                "summary": "List all tasks",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Task list"}},
            },
            "post": {
                "tags": ["Tasks"],
                "summary": "Create a new task",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Task created"}},
            },
        },
        "/api/leave_requests": {
            "get": {
                "tags": ["Leave"],
                "summary": "List leave requests",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Leave request list"}},
            },
            "post": {
                "tags": ["Leave"],
                "summary": "Create a leave request",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Leave request created"}},
            },
        },
        "/geofence_settings": {
            "get": {
                "tags": ["Settings"],
                "summary": "Get geofence configuration",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Current geofence settings"}},
            },
            "put": {
                "tags": ["Settings"],
                "summary": "Update geofence configuration",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Settings updated"}},
            },
        },
        "/api/dashboard/summary": {
            "get": {
                "tags": ["Reports"],
                "summary": "Dashboard summary (present/absent/late counts)",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Dashboard summary data"}},
            }
        },
        "/api/reports/attendance": {
            "get": {
                "tags": ["Reports"],
                "summary": "Detailed attendance report with analytics",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Attendance report"}},
            }
        },
        "/api/notifications": {
            "get": {
                "tags": ["Notifications"],
                "summary": "List notifications",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Notification list"}},
            }
        },
        "/train_model": {
            "post": {
                "tags": ["Training"],
                "summary": "Start face model training",
                "security": [{"BearerAuth": []}],
                "responses": {
                    "202": {"description": "Training started"},
                    "409": {"description": "Training already in progress"},
                },
            }
        },
        "/api/account/profile": {
            "get": {
                "tags": ["Account"],
                "summary": "Get admin profile",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Profile data"}},
            }
        },
        "/api/warn-employee": {
            "post": {
                "tags": ["Warnings"],
                "summary": "Send attendance warning email to employee",
                "security": [{"BearerAuth": []}],
                "responses": {"200": {"description": "Warning sent"}},
            }
        },
    },
}


@api_docs_bp.route("/api/docs", methods=["GET"])
def openapi_spec():
    """Return OpenAPI 3.0 specification as JSON."""
    return jsonify(OPENAPI_SPEC)


@api_docs_bp.route("/api/docs/ui", methods=["GET"])
def swagger_ui():
    """Serve a minimal Swagger UI page."""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>HRMS API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({{ url: '/api/docs', dom_id: '#swagger-ui' }})
  </script>
</body>
</html>"""
