# ==========================================================================
# Item 11: Multi-Tenant Architecture
# Provides tenant isolation via middleware that routes requests to
# tenant-specific database prefixes or separate databases.
# ==========================================================================
import os
from datetime import datetime, timezone
from functools import wraps
from flask import Blueprint, g, jsonify, request

multi_tenant_bp = Blueprint("multi_tenant", __name__)

# Tenant resolution strategy: "header", "subdomain", or "path"
TENANT_STRATEGY = os.getenv("TENANT_STRATEGY", "header")
TENANT_HEADER = os.getenv("TENANT_HEADER", "X-Tenant-ID")
DEFAULT_TENANT = os.getenv("DEFAULT_TENANT", "default")


def _get_db():
    from flask import current_app
    return current_app.config.get("_db")


# ==================== Tenant Resolution Middleware ====================

def resolve_tenant():
    """
    Middleware: Resolve tenant ID from request.
    Must be called in a before_request hook.

    Sets g.tenant_id and g.tenant for use in route handlers.
    """
    tenant_id = DEFAULT_TENANT

    if TENANT_STRATEGY == "header":
        tenant_id = request.headers.get(TENANT_HEADER, DEFAULT_TENANT).strip().lower()
    elif TENANT_STRATEGY == "subdomain":
        host = request.host or ""
        parts = host.split(".")
        if len(parts) >= 3:
            tenant_id = parts[0]
    elif TENANT_STRATEGY == "path":
        path_parts = (request.path or "").strip("/").split("/")
        if len(path_parts) >= 2 and path_parts[0] == "t":
            tenant_id = path_parts[1]

    # Sanitize
    tenant_id = "".join(c for c in tenant_id if c.isalnum() or c in "-_")[:50] or DEFAULT_TENANT

    g.tenant_id = tenant_id

    # Load tenant config from DB
    db = _get_db()
    if db:
        tenant = db.tenants.find_one({"tenant_id": tenant_id})
        g.tenant = tenant or {"tenant_id": tenant_id, "name": tenant_id.title(), "is_default": True}
    else:
        g.tenant = {"tenant_id": tenant_id, "name": tenant_id.title(), "is_default": True}


def require_tenant(fn):
    """Decorator: Ensure tenant is resolved before handler runs."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not hasattr(g, "tenant_id"):
            resolve_tenant()
        return fn(*args, **kwargs)
    return wrapper


def get_tenant_collection(base_collection_name: str):
    """
    Get a tenant-scoped collection name.
    In prefix mode: returns "tenant_abc__employees" for tenant "abc" and collection "employees".
    """
    tenant_id = getattr(g, "tenant_id", DEFAULT_TENANT)
    if tenant_id == DEFAULT_TENANT:
        return base_collection_name
    return f"t_{tenant_id}__{base_collection_name}"


# ==================== Tenant Management API ====================

@multi_tenant_bp.route("/api/tenants", methods=["GET"])
def list_tenants():
    """List all tenants (super-admin only)."""
    db = _get_db()
    if not db:
        return jsonify([])
    tenants = list(db.tenants.find({}).sort("name", 1))
    for t in tenants:
        t["_id"] = str(t["_id"])
    return jsonify(tenants)


@multi_tenant_bp.route("/api/tenants", methods=["POST"])
def create_tenant():
    """Create a new tenant."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    tenant_id = (payload.get("tenant_id") or "").strip().lower()
    name = (payload.get("name") or "").strip()

    if not tenant_id or not name:
        return jsonify({"message": "tenant_id and name are required"}), 400

    # Sanitize tenant_id
    tenant_id = "".join(c for c in tenant_id if c.isalnum() or c in "-_")[:50]

    if db.tenants.find_one({"tenant_id": tenant_id}):
        return jsonify({"message": f"Tenant '{tenant_id}' already exists"}), 409

    doc = {
        "tenant_id": tenant_id,
        "name": name,
        "domain": payload.get("domain", ""),
        "plan": payload.get("plan", "free"),
        "max_employees": int(payload.get("max_employees", 50)),
        "is_active": True,
        "features": payload.get("features", {
            "face_recognition": True,
            "geofence": True,
            "tasks": True,
            "leave_management": True,
            "payroll": False,
            "shift_scheduling": False,
            "analytics": True,
        }),
        "branding": payload.get("branding", {}),
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    db.tenants.insert_one(doc)
    doc.pop("_id", None)
    return jsonify({"message": "Tenant created", "tenant": doc})


@multi_tenant_bp.route("/api/tenants/<tenant_id>", methods=["PUT"])
def update_tenant(tenant_id):
    """Update tenant configuration."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    update_fields = {"updated_at": datetime.now(timezone.utc)}

    for field in ["name", "domain", "plan", "max_employees", "is_active", "features", "branding"]:
        if field in payload:
            update_fields[field] = payload[field]

    result = db.tenants.update_one({"tenant_id": tenant_id}, {"$set": update_fields})
    if result.matched_count == 0:
        return jsonify({"message": "Tenant not found"}), 404
    return jsonify({"message": "Tenant updated"})


@multi_tenant_bp.route("/api/tenants/<tenant_id>", methods=["DELETE"])
def delete_tenant(tenant_id):
    """Deactivate a tenant (soft delete)."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    if tenant_id == DEFAULT_TENANT:
        return jsonify({"message": "Cannot delete default tenant"}), 403

    result = db.tenants.update_one(
        {"tenant_id": tenant_id},
        {"$set": {"is_active": False, "updated_at": datetime.now(timezone.utc)}},
    )
    if result.matched_count == 0:
        return jsonify({"message": "Tenant not found"}), 404
    return jsonify({"message": "Tenant deactivated"})


@multi_tenant_bp.route("/api/tenants/<tenant_id>/stats", methods=["GET"])
def tenant_stats(tenant_id):
    """Get usage statistics for a tenant."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    tenant = db.tenants.find_one({"tenant_id": tenant_id})
    if not tenant:
        return jsonify({"message": "Tenant not found"}), 404

    # Count resources for this tenant
    prefix = get_tenant_collection("")
    emp_count = db[f"{prefix}employees"].count_documents({}) if prefix != "" else db.employees.count_documents({})

    return jsonify({
        "tenant_id": tenant_id,
        "name": tenant.get("name", ""),
        "plan": tenant.get("plan", "free"),
        "employee_count": emp_count,
        "max_employees": tenant.get("max_employees", 50),
        "is_active": tenant.get("is_active", True),
        "features": tenant.get("features", {}),
    })
