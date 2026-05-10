# ==========================================================================
# Item 10: Role-Based Access Control (RBAC)
# Defines roles, permissions, and decorators for granular access control.
# ==========================================================================
import os
from functools import wraps
from flask import g, jsonify, request


# ==================== Role Definitions ====================

ROLES = {
    "super_admin": {
        "label": "Super Admin",
        "level": 100,
        "description": "Full system access including system configuration and user management",
    },
    "admin": {
        "label": "Admin",
        "level": 80,
        "description": "Full HR management access",
    },
    "hr_manager": {
        "label": "HR Manager",
        "level": 60,
        "description": "Manage employees, attendance, and leave. Cannot modify system settings.",
    },
    "manager": {
        "label": "Manager",
        "level": 40,
        "description": "View team attendance, approve leaves, assign tasks to direct reports.",
    },
    "team_lead": {
        "label": "Team Lead",
        "level": 30,
        "description": "View team attendance, manage team tasks.",
    },
    "staff": {
        "label": "Staff",
        "level": 10,
        "description": "View own attendance, manage own tasks, request leave.",
    },
}

# ==================== Permission Definitions ====================

PERMISSIONS = {
    # Employee management
    "employees.read": {"label": "View Employees", "min_role_level": 40},
    "employees.create": {"label": "Create Employees", "min_role_level": 60},
    "employees.update": {"label": "Update Employees", "min_role_level": 60},
    "employees.delete": {"label": "Delete Employees", "min_role_level": 80},
    "employees.reset_password": {"label": "Reset Employee Passwords", "min_role_level": 60},

    # Attendance
    "attendance.read_all": {"label": "View All Attendance", "min_role_level": 40},
    "attendance.read_own": {"label": "View Own Attendance", "min_role_level": 10},
    "attendance.mark_manual": {"label": "Add Manual Attendance", "min_role_level": 60},
    "attendance.approve_manual": {"label": "Approve Manual Requests", "min_role_level": 60},

    # Leave
    "leave.request": {"label": "Request Leave", "min_role_level": 10},
    "leave.approve": {"label": "Approve Leave", "min_role_level": 40},
    "leave.manage_balance": {"label": "Manage Leave Balances", "min_role_level": 60},
    "leave.view_all": {"label": "View All Leave Requests", "min_role_level": 40},

    # Tasks
    "tasks.create": {"label": "Create Tasks", "min_role_level": 30},
    "tasks.assign": {"label": "Assign Tasks", "min_role_level": 30},
    "tasks.approve": {"label": "Approve Task Completion", "min_role_level": 40},
    "tasks.delete": {"label": "Delete Tasks", "min_role_level": 60},

    # Settings
    "settings.read": {"label": "View Settings", "min_role_level": 60},
    "settings.update": {"label": "Update Settings", "min_role_level": 80},
    "settings.geofence": {"label": "Manage Geofence", "min_role_level": 80},

    # Reports
    "reports.view": {"label": "View Reports", "min_role_level": 40},
    "reports.export": {"label": "Export Reports", "min_role_level": 40},

    # System
    "system.train_model": {"label": "Train Face Model", "min_role_level": 80},
    "system.view_logs": {"label": "View Audit Logs", "min_role_level": 60},
    "system.manage_admins": {"label": "Manage Admin Accounts", "min_role_level": 100},

    # Assets
    "assets.read": {"label": "View Assets", "min_role_level": 40},
    "assets.upload": {"label": "Upload Assets", "min_role_level": 60},
    "assets.delete": {"label": "Delete Assets", "min_role_level": 60},

    # Warnings
    "warnings.send": {"label": "Send Warnings", "min_role_level": 60},
    "warnings.configure": {"label": "Configure Warning Rules", "min_role_level": 80},

    # Notifications
    "notifications.read": {"label": "Read Notifications", "min_role_level": 10},
    "notifications.create": {"label": "Create Notifications", "min_role_level": 40},
}


# ==================== Permission Checking ====================

def get_role_level(role_name: str) -> int:
    """Get the numeric level for a role name."""
    role_name = str(role_name or "staff").strip().lower()
    role_info = ROLES.get(role_name)
    if role_info:
        return role_info["level"]
    return ROLES.get("staff", {}).get("level", 10)


def has_permission(role_name: str, permission: str) -> bool:
    """Check if a role has a specific permission."""
    role_level = get_role_level(role_name)
    perm_info = PERMISSIONS.get(permission)
    if not perm_info:
        return False
    return role_level >= perm_info.get("min_role_level", 100)


def get_role_permissions(role_name: str) -> list:
    """Get all permissions for a role."""
    role_level = get_role_level(role_name)
    return [
        perm_key
        for perm_key, perm_info in PERMISSIONS.items()
        if role_level >= perm_info.get("min_role_level", 100)
    ]


# ==================== Decorators ====================

def require_permission(permission: str):
    """
    Decorator: Require a specific permission to access an endpoint.
    
    Usage:
        @app.get("/api/employees")
        @admin_auth_required
        @require_permission("employees.read")
        def list_employees():
            ...
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            # Get role from admin claims
            claims = getattr(g, "admin_claims", {}) or {}
            role = str(claims.get("role", "admin")).strip().lower()

            # Legacy admin tokens without role field get full admin access
            if not claims.get("role") and claims.get("sub"):
                role = "admin"

            if not has_permission(role, permission):
                return jsonify({
                    "message": "Insufficient permissions",
                    "required_permission": permission,
                    "your_role": role,
                }), 403
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def require_role(min_role: str):
    """
    Decorator: Require a minimum role level.
    
    Usage:
        @require_role("hr_manager")
        def manage_employees():
            ...
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            claims = getattr(g, "admin_claims", {}) or {}
            role = str(claims.get("role", "admin")).strip().lower()

            if not claims.get("role") and claims.get("sub"):
                role = "admin"

            if get_role_level(role) < get_role_level(min_role):
                return jsonify({
                    "message": f"Requires at least {min_role} role",
                    "your_role": role,
                }), 403
            return fn(*args, **kwargs)
        return wrapper
    return decorator
