# ==========================================================================
# Item 11: Leave Management System
# Provides leave types, balance tracking, approval workflows, and calendar.
# Official Policy: EL=16, CL=10, SL=6  (Total: 32 days/year)
# ==========================================================================
from datetime import datetime, timezone, timedelta
from flask import Blueprint, g, jsonify, request
from bson import ObjectId
from bson.errors import InvalidId

leave_mgmt_bp = Blueprint("leave_mgmt", __name__)


# ==================== Official Leave Policy ====================

DEFAULT_LEAVE_TYPES = [
    {
        "code": "EL",
        "name": "Earned Leave",
        "annual_quota": 16,
        "carry_forward": True,
        "max_carry_forward": 32,
        "max_consecutive_days": 30,
        "requires_attachment": False,
        "paid": True,
        "description": "Planned long leave. Carry-forward allowed.",
        "color": "#22c55e",
    },
    {
        "code": "CL",
        "name": "Casual Leave",
        "annual_quota": 10,
        "carry_forward": False,
        "max_consecutive_days": 3,
        "requires_attachment": False,
        "paid": True,
        "description": "Short-term personal leave. No carry-forward.",
        "color": "#3b82f6",
    },
    {
        "code": "SL",
        "name": "Sick Leave",
        "annual_quota": 6,
        "carry_forward": False,
        "max_consecutive_days": 7,
        "requires_attachment_after_days": 2,
        "requires_attachment": False,
        "paid": True,
        "description": "Medical leave. Document upload optional.",
        "color": "#ef4444",
    },
    {
        "code": "LOP",
        "name": "Loss of Pay",
        "annual_quota": 999,
        "carry_forward": False,
        "max_consecutive_days": 30,
        "requires_attachment": False,
        "paid": False,
        "auto_generated": True,
        "description": "Auto-generated when leave balance exhausted. Unpaid.",
        "color": "#94a3b8",
    },
]

# Total annual paid leave = 16 + 10 + 6 = 32 days
ANNUAL_LEAVE_TOTAL = sum(lt["annual_quota"] for lt in DEFAULT_LEAVE_TYPES if lt.get("paid"))

# Sandwich leave policy (admin-configurable)
DEFAULT_SANDWICH_RULE_ENABLED = False


def _get_db():
    """Get the MongoDB database from Flask app."""
    from flask import current_app
    db = current_app.config.get("_db")
    if db is not None:
        return db
    return current_app.extensions.get("pymongo_db")


# ==================== Leave Type Routes ====================

@leave_mgmt_bp.route("/api/leave-types", methods=["GET"])
def list_leave_types():
    """List all leave types."""
    db = _get_db()
    if db is None:
        return jsonify(DEFAULT_LEAVE_TYPES)
    custom_types = list(db.leave_types.find({}, {"_id": 0}))
    if not custom_types:
        return jsonify(DEFAULT_LEAVE_TYPES)
    return jsonify(custom_types)


@leave_mgmt_bp.route("/api/leave-types", methods=["POST"])
def create_leave_type():
    """Create a new leave type (admin only)."""
    payload = request.get_json(silent=True) or {}
    code = (payload.get("code") or "").strip().upper()
    name = (payload.get("name") or "").strip()

    if not code or not name:
        return jsonify({"message": "code and name are required"}), 400

    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    if db.leave_types.find_one({"code": code}):
        return jsonify({"message": f"Leave type '{code}' already exists"}), 409

    doc = {
        "code": code,
        "name": name,
        "annual_quota": int(payload.get("annual_quota", 0)),
        "carry_forward": bool(payload.get("carry_forward", False)),
        "max_carry_forward": int(payload.get("max_carry_forward", 0)),
        "max_consecutive_days": int(payload.get("max_consecutive_days", 30)),
        "requires_attachment": bool(payload.get("requires_attachment", False)),
        "color": payload.get("color", "#94a3b8"),
        "created_at": datetime.now(timezone.utc),
    }
    db.leave_types.insert_one(doc)
    doc.pop("_id", None)
    return jsonify({"message": "Leave type created", "leave_type": doc})


# ==================== Leave Balance Routes ====================

@leave_mgmt_bp.route("/api/leave-balance/<employee_id>", methods=["GET"])
def get_leave_balance(employee_id):
    """Get leave balance for an employee."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    year = int(request.args.get("year", datetime.now().year))

    # Get or create balance record
    balance = db.leave_balances.find_one({
        "employee_id": employee_id,
        "year": year,
    })

    if not balance:
        # Initialize with default quotas
        leave_types = list(db.leave_types.find({}, {"_id": 0})) or DEFAULT_LEAVE_TYPES
        balance_data = {}
        for lt in leave_types:
            balance_data[lt["code"]] = {
                "name": lt["name"],
                "total": lt["annual_quota"],
                "used": 0,
                "pending": 0,
                "available": lt["annual_quota"],
            }

        doc = {
            "employee_id": employee_id,
            "year": year,
            "balances": balance_data,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }
        db.leave_balances.insert_one(doc)
        doc.pop("_id", None)
        return jsonify(doc)

    balance["_id"] = str(balance.get("_id", ""))
    return jsonify(balance)


@leave_mgmt_bp.route("/api/leave-balance/<employee_id>/adjust", methods=["POST"])
def adjust_leave_balance(employee_id):
    """Adjust leave balance (admin/HR only)."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    leave_code = (payload.get("leave_code") or "").strip().upper()
    adjustment = int(payload.get("adjustment", 0))
    reason = (payload.get("reason") or "").strip()

    if not leave_code:
        return jsonify({"message": "leave_code is required"}), 400

    year = int(payload.get("year", datetime.now().year))
    balance = db.leave_balances.find_one({
        "employee_id": employee_id,
        "year": year,
    })

    if not balance:
        return jsonify({"message": "Leave balance not found. View balance first to initialize."}), 404

    balances = balance.get("balances", {})
    if leave_code not in balances:
        return jsonify({"message": f"Leave type '{leave_code}' not found in balance"}), 404

    current = balances[leave_code]
    current["total"] = max(0, current.get("total", 0) + adjustment)
    current["available"] = max(0, current["total"] - current.get("used", 0) - current.get("pending", 0))

    db.leave_balances.update_one(
        {"_id": balance["_id"]},
        {
            "$set": {
                f"balances.{leave_code}": current,
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )

    return jsonify({
        "message": "Balance adjusted",
        "leave_code": leave_code,
        "new_balance": current,
    })


# ==================== Enhanced Leave Request Routes ====================

@leave_mgmt_bp.route("/api/leave-requests/apply", methods=["POST"])
def apply_for_leave():
    """Employee applies for leave with type, dates, and reason.

    Auto-converts to LOP when balance exhausted.
    Supports half-day (0.5 deduction) and sandwich rule.
    """
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    leave_code = (payload.get("leave_code") or "CL").strip().upper()
    start_date = (payload.get("start_date") or "").strip()
    end_date = (payload.get("end_date") or start_date).strip()
    reason = (payload.get("reason") or "").strip()
    employee_id = (payload.get("employee_id") or "").strip()
    employee_name = (payload.get("employee_name") or "").strip()
    half_day = bool(payload.get("half_day", False))
    half_day_period = (payload.get("half_day_period") or "first_half").strip()

    if not start_date or not employee_id:
        return jsonify({"message": "start_date and employee_id are required"}), 400

    # SL requires reason
    if leave_code == "SL" and not reason:
        return jsonify({"message": "Reason is required for Sick Leave"}), 400

    try:
        start = datetime.strptime(start_date, "%Y-%m-%d").date()
        end = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"message": "Invalid date format. Use YYYY-MM-DD."}), 400

    if end < start:
        return jsonify({"message": "end_date cannot be before start_date"}), 400

    num_days = (end - start).days + 1
    if half_day:
        num_days = 0.5

    # Check leave balance and auto-convert to LOP if needed
    year = start.year
    balance = db.leave_balances.find_one({"employee_id": employee_id, "year": year})

    available = 999
    lop_days = 0
    original_leave_code = leave_code
    auto_lop = False

    if balance:
        balances = balance.get("balances", {})
        leave_info = balances.get(leave_code, {})
        available = leave_info.get("available", 0)

    if leave_code not in ("LOP", "LWP") and num_days > available:
        # Auto-convert excess to LOP
        if available > 0:
            lop_days = num_days - available
            num_days = available
            auto_lop = True
        else:
            leave_code = "LOP"
            lop_days = num_days if not half_day else 0.5
            auto_lop = True

    now = datetime.now(timezone.utc)
    leave_request = {
        "employee_id": employee_id,
        "employee_name": employee_name,
        "leave_code": leave_code,
        "original_leave_code": original_leave_code,
        "start_date": start_date,
        "end_date": end_date,
        "num_days": num_days,
        "half_day": half_day,
        "half_day_period": half_day_period if half_day else None,
        "reason": reason,
        "status": "pending",
        "lop_days": lop_days,
        "auto_lop": auto_lop,
        "applied_at": now,
        "updated_at": now,
        "approved_by": None,
        "approved_at": None,
        "rejection_reason": None,
        "approval_timeline": [{
            "action": "applied",
            "by": employee_name or employee_id,
            "at": now,
            "comment": reason,
        }],
    }

    result = db.leave_requests_v2.insert_one(leave_request)
    leave_request["_id"] = str(result.inserted_id)

    if balance and leave_code != "LOP":
        db.leave_balances.update_one(
            {"_id": balance["_id"]},
            {
                "$inc": {f"balances.{leave_code}.pending": num_days},
                "$set": {"updated_at": now},
            },
        )

    # Audit log
    _log_leave_audit(db, "leave_applied", {
        "request_id": str(result.inserted_id),
        "employee_id": employee_id,
        "leave_code": leave_code,
        "num_days": num_days,
        "lop_days": lop_days,
        "auto_lop": auto_lop,
    })

    msg = "Leave request submitted"
    if auto_lop and lop_days > 0:
        msg += f" ({lop_days} day(s) auto-converted to LOP)"

    return jsonify({"message": msg, "request": leave_request})


@leave_mgmt_bp.route("/api/leave-requests/approve/<request_id>", methods=["POST"])
def approve_leave_v2(request_id):
    """Approve a leave request, deduct balance, and log approval timeline."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    try:
        oid = ObjectId(request_id)
    except (InvalidId, Exception):
        return jsonify({"message": "Invalid request ID"}), 400

    leave_req = db.leave_requests_v2.find_one({"_id": oid})
    if not leave_req:
        return jsonify({"message": "Leave request not found"}), 404

    if leave_req.get("status") != "pending":
        return jsonify({"message": f"Request is already {leave_req.get('status')}"}), 409

    payload = request.get_json(silent=True) or {}
    claims = getattr(g, "admin_claims", {}) or {}
    approved_by = payload.get("approver_name") or claims.get("sub", "admin")
    comment = (payload.get("comment") or "").strip()
    now = datetime.now(timezone.utc)

    timeline_entry = {"action": "approved", "by": approved_by, "at": now, "comment": comment}

    db.leave_requests_v2.update_one(
        {"_id": oid},
        {
            "$set": {
                "status": "approved",
                "approved_by": approved_by,
                "approved_at": now,
                "updated_at": now,
            },
            "$push": {"approval_timeline": timeline_entry},
        },
    )

    employee_id = leave_req["employee_id"]
    leave_code = leave_req["leave_code"]
    num_days = leave_req["num_days"]
    year = int(leave_req["start_date"][:4])

    if leave_code != "LOP":
        balance = db.leave_balances.find_one({"employee_id": employee_id, "year": year})
        if balance:
            db.leave_balances.update_one(
                {"_id": balance["_id"]},
                {
                    "$inc": {
                        f"balances.{leave_code}.pending": -num_days,
                        f"balances.{leave_code}.used": num_days,
                        f"balances.{leave_code}.available": -num_days,
                    },
                    "$set": {"updated_at": now},
                },
            )

    _log_leave_audit(db, "leave_approved", {
        "request_id": request_id, "employee_id": employee_id,
        "leave_code": leave_code, "num_days": num_days, "approved_by": approved_by,
    })

    return jsonify({"message": "Leave approved", "request_id": request_id})


@leave_mgmt_bp.route("/api/leave-requests/reject/<request_id>", methods=["POST"])
def reject_leave_v2(request_id):
    """Reject a leave request, restore balance, and log timeline."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    try:
        oid = ObjectId(request_id)
    except (InvalidId, Exception):
        return jsonify({"message": "Invalid request ID"}), 400

    payload = request.get_json(silent=True) or {}
    rejection_reason = (payload.get("reason") or "").strip()

    leave_req = db.leave_requests_v2.find_one({"_id": oid})
    if not leave_req:
        return jsonify({"message": "Leave request not found"}), 404

    if leave_req.get("status") != "pending":
        return jsonify({"message": f"Request is already {leave_req.get('status')}"}), 409

    claims = getattr(g, "admin_claims", {}) or {}
    rejected_by = payload.get("rejector_name") or claims.get("sub", "admin")
    now = datetime.now(timezone.utc)
    timeline_entry = {"action": "rejected", "by": rejected_by, "at": now, "comment": rejection_reason}

    db.leave_requests_v2.update_one(
        {"_id": oid},
        {
            "$set": {
                "status": "rejected",
                "rejected_by": rejected_by,
                "rejection_reason": rejection_reason,
                "updated_at": now,
            },
            "$push": {"approval_timeline": timeline_entry},
        },
    )

    employee_id = leave_req["employee_id"]
    leave_code = leave_req["leave_code"]
    num_days = leave_req["num_days"]
    year = int(leave_req["start_date"][:4])

    if leave_code != "LOP":
        balance = db.leave_balances.find_one({"employee_id": employee_id, "year": year})
        if balance:
            db.leave_balances.update_one(
                {"_id": balance["_id"]},
                {
                    "$inc": {f"balances.{leave_code}.pending": -num_days},
                    "$set": {"updated_at": now},
                },
            )

    _log_leave_audit(db, "leave_rejected", {
        "request_id": request_id, "employee_id": employee_id,
        "leave_code": leave_code, "rejected_by": rejected_by,
    })

    return jsonify({"message": "Leave rejected", "request_id": request_id})


# ==================== Leave Calendar ====================

@leave_mgmt_bp.route("/api/leave-calendar", methods=["GET"])
def leave_calendar():
    """Get leave calendar for a date range (for calendar view)."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    from_date = request.args.get("from_date", "")
    to_date = request.args.get("to_date", "")
    department = request.args.get("department", "")

    if not from_date or not to_date:
        return jsonify({"message": "from_date and to_date are required"}), 400

    query = {
        "status": "approved",
        "$or": [
            {"start_date": {"$gte": from_date, "$lte": to_date}},
            {"end_date": {"$gte": from_date, "$lte": to_date}},
            {"start_date": {"$lte": from_date}, "end_date": {"$gte": to_date}},
        ],
    }

    leaves = list(db.leave_requests_v2.find(query).sort("start_date", 1))
    events = []
    for leave in leaves:
        events.append({
            "id": str(leave.get("_id", "")),
            "employee_id": leave.get("employee_id"),
            "leave_code": leave.get("leave_code"),
            "start_date": leave.get("start_date"),
            "end_date": leave.get("end_date"),
            "num_days": leave.get("num_days"),
            "half_day": leave.get("half_day", False),
            "status": leave.get("status"),
        })

    return jsonify({"events": events, "from_date": from_date, "to_date": to_date})


# ==================== Holiday Calendar ====================

@leave_mgmt_bp.route("/api/holidays", methods=["GET"])
def list_holidays():
    """List public holidays for a year."""
    db = _get_db()
    if db is None:
        return jsonify([])

    year = int(request.args.get("year", datetime.now().year))
    holidays = list(db.holidays.find({"year": year}, {"_id": 0}).sort("date", 1))
    return jsonify(holidays)


@leave_mgmt_bp.route("/api/holidays", methods=["POST"])
def create_holiday():
    """Add a public holiday."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    date = (payload.get("date") or "").strip()
    name = (payload.get("name") or "").strip()

    if not date or not name:
        return jsonify({"message": "date and name are required"}), 400

    try:
        parsed = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"message": "Invalid date format. Use YYYY-MM-DD."}), 400

    doc = {
        "date": date,
        "name": name,
        "year": parsed.year,
        "optional": bool(payload.get("optional", False)),
        "created_at": datetime.now(timezone.utc),
    }
    db.holidays.insert_one(doc)
    doc.pop("_id", None)
    return jsonify({"message": "Holiday added", "holiday": doc})


@leave_mgmt_bp.route("/api/holidays/<date>", methods=["DELETE"])
def delete_holiday(date):
    """Delete a holiday by date."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    result = db.holidays.delete_one({"date": date})
    if result.deleted_count == 0:
        return jsonify({"message": "Holiday not found"}), 404
    return jsonify({"message": "Holiday deleted"})


# ==================== Audit & Analytics ====================

def _log_leave_audit(db, action: str, details: dict):
    """Log an audit event for leave actions."""
    if db is None:
        return
    
    claims = getattr(g, "admin_claims", {}) or {}
    actor = claims.get("sub", "system")
    
    audit_doc = {
        "action": action,
        "actor": actor,
        "details": details,
        "timestamp": datetime.now(timezone.utc),
    }
    db.leave_audit_logs.insert_one(audit_doc)

@leave_mgmt_bp.route("/api/leave-analytics", methods=["GET"])
def leave_analytics():
    """Get analytics for leave usage, optionally filtered by company."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    year = int(request.args.get("year", datetime.now().year))
    company_id = str(request.args.get("company_id") or "").strip()

    match_stage = {"status": "approved"}

    if company_id:
        from src.utils.company_scope import list_company_employee_id_strings

        emp_ids = list_company_employee_id_strings(db, company_id)
        match_stage["employee_id"] = {"$in": emp_ids}

    pipeline = [
        {"$match": match_stage},
        {"$group": {
            "_id": "$leave_code",
            "total_days": {"$sum": "$num_days"},
            "request_count": {"$sum": 1}
        }}
    ]

    usage_by_type = list(db.leave_requests_v2.aggregate(pipeline))

    return jsonify({
        "year": year,
        "usage_by_type": usage_by_type
    })

@leave_mgmt_bp.route("/api/leave-policy/sandwich", methods=["GET", "POST"])
def manage_sandwich_policy():
    """Get or update sandwich leave policy."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    if request.method == "GET":
        settings = db.leave_settings.find_one({"_id": "sandwich_rule"})
        enabled = settings.get("enabled", DEFAULT_SANDWICH_RULE_ENABLED) if settings else DEFAULT_SANDWICH_RULE_ENABLED
        return jsonify({"sandwich_rule_enabled": enabled})
        
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        
        db.leave_settings.update_one(
            {"_id": "sandwich_rule"},
            {"$set": {"enabled": enabled, "updated_at": datetime.now(timezone.utc)}},
            upsert=True
        )
        return jsonify({"message": "Sandwich policy updated", "sandwich_rule_enabled": enabled})
