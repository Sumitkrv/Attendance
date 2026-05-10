# ==========================================================================
# Item 5: Shift Scheduling Module
# Create shift templates, assign shifts to employees, manage rotations.
# ==========================================================================
from datetime import datetime, timezone, timedelta, date
from flask import Blueprint, g, jsonify, request
from bson import ObjectId
from bson.errors import InvalidId

shift_bp = Blueprint("shifts", __name__)


def _get_db():
    from flask import current_app
    return current_app.config.get("_db")


# ==================== Default Shift Templates ====================

DEFAULT_SHIFTS = [
    {
        "code": "GEN",
        "name": "General Shift",
        "start_time": "09:00",
        "end_time": "18:00",
        "break_minutes": 60,
        "grace_minutes": 15,
        "color": "#3b82f6",
        "is_default": True,
    },
    {
        "code": "MRN",
        "name": "Morning Shift",
        "start_time": "06:00",
        "end_time": "14:00",
        "break_minutes": 30,
        "grace_minutes": 10,
        "color": "#f59e0b",
        "is_default": False,
    },
    {
        "code": "EVE",
        "name": "Evening Shift",
        "start_time": "14:00",
        "end_time": "22:00",
        "break_minutes": 30,
        "grace_minutes": 10,
        "color": "#8b5cf6",
        "is_default": False,
    },
    {
        "code": "NGT",
        "name": "Night Shift",
        "start_time": "22:00",
        "end_time": "06:00",
        "break_minutes": 30,
        "grace_minutes": 10,
        "is_overnight": True,
        "color": "#1e293b",
        "is_default": False,
    },
    {
        "code": "FLX",
        "name": "Flexible",
        "start_time": "08:00",
        "end_time": "20:00",
        "min_hours": 8,
        "break_minutes": 60,
        "grace_minutes": 0,
        "is_flexible": True,
        "color": "#22c55e",
        "is_default": False,
    },
]


# ==================== Shift Template CRUD ====================

@shift_bp.route("/api/shifts", methods=["GET"])
def list_shifts():
    """List all shift templates."""
    db = _get_db()
    if not db:
        return jsonify(DEFAULT_SHIFTS)
    shifts = list(db.shift_templates.find({}).sort("name", 1))
    if not shifts:
        return jsonify(DEFAULT_SHIFTS)
    for s in shifts:
        s["_id"] = str(s["_id"])
    return jsonify(shifts)


@shift_bp.route("/api/shifts", methods=["POST"])
def create_shift():
    """Create a new shift template."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    code = (payload.get("code") or "").strip().upper()
    name = (payload.get("name") or "").strip()
    start_time = (payload.get("start_time") or "").strip()
    end_time = (payload.get("end_time") or "").strip()

    if not code or not name or not start_time or not end_time:
        return jsonify({"message": "code, name, start_time, and end_time are required"}), 400

    if db.shift_templates.find_one({"code": code}):
        return jsonify({"message": f"Shift code '{code}' already exists"}), 409

    doc = {
        "code": code,
        "name": name,
        "start_time": start_time,
        "end_time": end_time,
        "break_minutes": int(payload.get("break_minutes", 60)),
        "grace_minutes": int(payload.get("grace_minutes", 15)),
        "min_hours": float(payload.get("min_hours", 0)),
        "is_overnight": bool(payload.get("is_overnight", False)),
        "is_flexible": bool(payload.get("is_flexible", False)),
        "is_default": False,
        "color": payload.get("color", "#94a3b8"),
        "created_at": datetime.now(timezone.utc),
    }
    result = db.shift_templates.insert_one(doc)
    doc["_id"] = str(result.inserted_id)
    return jsonify({"message": "Shift created", "shift": doc})


@shift_bp.route("/api/shifts/<shift_id>", methods=["PUT"])
def update_shift(shift_id):
    """Update a shift template."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    try:
        oid = ObjectId(shift_id)
    except (InvalidId, Exception):
        return jsonify({"message": "Invalid shift ID"}), 400

    payload = request.get_json(silent=True) or {}
    update_fields = {"updated_at": datetime.now(timezone.utc)}
    for field in ["name", "start_time", "end_time", "break_minutes", "grace_minutes",
                  "min_hours", "is_overnight", "is_flexible", "color"]:
        if field in payload:
            update_fields[field] = payload[field]

    db.shift_templates.update_one({"_id": oid}, {"$set": update_fields})
    return jsonify({"message": "Shift updated"})


@shift_bp.route("/api/shifts/<shift_id>", methods=["DELETE"])
def delete_shift(shift_id):
    """Delete a shift template."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503
    try:
        oid = ObjectId(shift_id)
    except (InvalidId, Exception):
        return jsonify({"message": "Invalid shift ID"}), 400
    result = db.shift_templates.delete_one({"_id": oid})
    if result.deleted_count == 0:
        return jsonify({"message": "Shift not found"}), 404
    return jsonify({"message": "Shift deleted"})


# ==================== Employee Shift Assignment ====================

@shift_bp.route("/api/shift-assignments", methods=["GET"])
def list_shift_assignments():
    """List shift assignments for a date range."""
    db = _get_db()
    if not db:
        return jsonify([])

    from_date = request.args.get("from_date", "")
    to_date = request.args.get("to_date", "")
    employee_id = request.args.get("employee_id", "")
    department = request.args.get("department", "")

    query = {}
    if from_date and to_date:
        query["date"] = {"$gte": from_date, "$lte": to_date}
    if employee_id:
        query["employee_id"] = employee_id
    if department:
        query["department"] = department

    assignments = list(db.shift_assignments.find(query).sort("date", 1).limit(500))
    for a in assignments:
        a["_id"] = str(a["_id"])
    return jsonify(assignments)


@shift_bp.route("/api/shift-assignments", methods=["POST"])
def assign_shift():
    """Assign a shift to an employee for specific date(s)."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    employee_id = (payload.get("employee_id") or "").strip()
    shift_code = (payload.get("shift_code") or "").strip().upper()
    start_date = (payload.get("start_date") or "").strip()
    end_date = (payload.get("end_date") or start_date).strip()

    if not employee_id or not shift_code or not start_date:
        return jsonify({"message": "employee_id, shift_code, and start_date are required"}), 400

    try:
        start = datetime.strptime(start_date, "%Y-%m-%d").date()
        end = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"message": "Invalid date format. Use YYYY-MM-DD."}), 400

    # Create assignment for each date in range
    assigned = 0
    current = start
    while current <= end:
        date_str = current.strftime("%Y-%m-%d")
        # Upsert — replace existing assignment for this date
        db.shift_assignments.update_one(
            {"employee_id": employee_id, "date": date_str},
            {"$set": {
                "employee_id": employee_id,
                "shift_code": shift_code,
                "date": date_str,
                "assigned_by": getattr(g, "admin_claims", {}).get("sub", "admin") if hasattr(g, "admin_claims") else "admin",
                "updated_at": datetime.now(timezone.utc),
            }},
            upsert=True,
        )
        assigned += 1
        current += timedelta(days=1)

    return jsonify({
        "message": f"Shift assigned for {assigned} day(s)",
        "employee_id": employee_id,
        "shift_code": shift_code,
        "start_date": start_date,
        "end_date": end_date,
    })


@shift_bp.route("/api/shift-assignments/bulk", methods=["POST"])
def bulk_assign_shifts():
    """Assign shifts to multiple employees at once."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    assignments = payload.get("assignments", [])

    if not assignments:
        return jsonify({"message": "assignments array is required"}), 400

    count = 0
    for item in assignments:
        emp_id = item.get("employee_id", "").strip()
        shift_code = item.get("shift_code", "").strip().upper()
        date_str = item.get("date", "").strip()

        if emp_id and shift_code and date_str:
            db.shift_assignments.update_one(
                {"employee_id": emp_id, "date": date_str},
                {"$set": {
                    "employee_id": emp_id,
                    "shift_code": shift_code,
                    "date": date_str,
                    "updated_at": datetime.now(timezone.utc),
                }},
                upsert=True,
            )
            count += 1

    return jsonify({"message": f"{count} shift assignment(s) saved"})


# ==================== Rotation Templates ====================

@shift_bp.route("/api/shift-rotations", methods=["GET"])
def list_rotations():
    """List shift rotation templates."""
    db = _get_db()
    if not db:
        return jsonify([])
    rotations = list(db.shift_rotations.find({}).sort("name", 1))
    for r in rotations:
        r["_id"] = str(r["_id"])
    return jsonify(rotations)


@shift_bp.route("/api/shift-rotations", methods=["POST"])
def create_rotation():
    """Create a shift rotation pattern (e.g., weekly rotation)."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    pattern = payload.get("pattern", [])  # e.g., ["GEN", "GEN", "EVE", "EVE", "NGT", "NGT", "OFF"]
    cycle_days = len(pattern)

    if not name or not pattern:
        return jsonify({"message": "name and pattern are required"}), 400

    doc = {
        "name": name,
        "pattern": pattern,
        "cycle_days": cycle_days,
        "description": payload.get("description", ""),
        "created_at": datetime.now(timezone.utc),
    }
    result = db.shift_rotations.insert_one(doc)
    doc["_id"] = str(result.inserted_id)
    return jsonify({"message": "Rotation created", "rotation": doc})
