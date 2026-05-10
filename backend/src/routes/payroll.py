# ==========================================================================
# Item 7: Payroll Calculation Module
# Handles salary structure, payroll runs, and payslip generation.
# ==========================================================================
from datetime import datetime, timezone, date
from calendar import monthrange
from flask import Blueprint, current_app, g, jsonify, request
from bson import ObjectId
from bson.errors import InvalidId

payroll_bp = Blueprint("payroll", __name__)


def _get_db():
    from flask import current_app
    return current_app.config.get("_db")


def _to_json_safe(value):
    """Convert Mongo/Python values into JSON-safe primitives."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, list):
        return [_to_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {key: _to_json_safe(val) for key, val in value.items()}
    return value


# ==================== Salary Structure ====================

DEFAULT_SALARY_COMPONENTS = {
    "earnings": [
        {"code": "BASIC", "name": "Basic Salary", "type": "earning", "percentage_of_ctc": 40, "is_fixed": True},
        {"code": "HRA", "name": "House Rent Allowance", "type": "earning", "percentage_of_basic": 50, "is_fixed": True},
        {"code": "CONV", "name": "Conveyance Allowance", "type": "earning", "fixed_amount": 1600, "is_fixed": True},
        {"code": "MED", "name": "Medical Allowance", "type": "earning", "fixed_amount": 1250, "is_fixed": True},
        {"code": "SPEC", "name": "Special Allowance", "type": "earning", "is_remainder": True, "is_fixed": True},
    ],
    "deductions": [
        {"code": "PF", "name": "Provident Fund", "type": "deduction", "percentage_of_basic": 12, "employer_match": True},
        {"code": "ESI", "name": "ESI", "type": "deduction", "percentage_of_gross": 0.75, "threshold_gross": 21000},
        {"code": "PT", "name": "Professional Tax", "type": "deduction", "fixed_amount": 200, "max_monthly": 200},
        {"code": "TDS", "name": "Income Tax (TDS)", "type": "deduction", "percentage_of_taxable": 0, "is_variable": True},
    ],
}


@payroll_bp.route("/api/payroll/salary-structure", methods=["GET"])
def get_salary_structure():
    """Get the default salary structure/components."""
    db = _get_db()
    if db is not None:
        custom = db.salary_structures.find_one({"is_default": True})
        if custom:
            custom["_id"] = str(custom["_id"])
            return jsonify(custom)
    return jsonify(DEFAULT_SALARY_COMPONENTS)


@payroll_bp.route("/api/payroll/employee/<employee_id>/structure", methods=["GET"])
def get_employee_salary(employee_id):
    """Get salary breakdown for a specific employee."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    try:
        emp = db.employees.find_one({"_id": ObjectId(employee_id)})
    except (InvalidId, Exception):
        emp = db.employees.find_one({"login_id": employee_id})

    if not emp:
        return jsonify({"message": "Employee not found"}), 404

    ctc = float(emp.get("salary", 0) or 0)
    if ctc <= 0:
        return jsonify({"message": "Salary not configured for this employee"}), 400

    breakdown = _calculate_salary_breakdown(ctc)
    breakdown["employee_id"] = str(emp["_id"])
    breakdown["employee_name"] = emp.get("name", "")
    return jsonify(breakdown)


# ==================== Payroll Run ====================

@payroll_bp.route("/api/payroll/run", methods=["POST"])
def run_payroll():
    """Run payroll for a specific month. Calculates salary for all active employees."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    year = int(payload.get("year", datetime.now().year))
    month = int(payload.get("month", datetime.now().month))
    department = payload.get("department")
    company_id = str(payload.get("company_id") or "").strip()

    # Check if payroll already run for this month (scoped by company if provided)
    existing_query = {"year": year, "month": month, "status": "completed"}
    if company_id:
        existing_query["company_id"] = company_id
    existing = db.payroll_runs.find_one(existing_query)
    if existing:
        return jsonify({"message": f"Payroll already run for {year}-{month:02d}"}), 409

    # Get all active employees
    emp_query = {"status": {"$in": ["active", "probation"]}}
    if department:
        emp_query["department"] = department
    if company_id:
        from src.utils.company_scope import employees_match_query_for_company

        emp_query = {"$and": [emp_query, employees_match_query_for_company(db, company_id)]}
    employees = list(db.employees.find(emp_query))

    if not employees:
        return jsonify({"message": "No active employees found"}), 400

    _, days_in_month = monthrange(year, month)
    payslips = []
    total_gross = 0
    total_net = 0
    total_deductions = 0

    for emp in employees:
        ctc = float(emp.get("salary", 0) or 0)
        if ctc <= 0:
            continue

        emp_id = str(emp["_id"])

        # Calculate working days vs present days
        working_days = _get_working_days(year, month, days_in_month)
        present_days = _get_present_days(db, emp_id, year, month)
        loss_of_pay_days = max(0, working_days - present_days)

        breakdown = _calculate_salary_breakdown(ctc)
        monthly_gross = breakdown["monthly_gross"]

        # Pro-rate for LOP
        if loss_of_pay_days > 0 and working_days > 0:
            lop_deduction = (monthly_gross / working_days) * loss_of_pay_days
        else:
            lop_deduction = 0

        net_salary = breakdown["monthly_net"] - lop_deduction

        payslip = {
            "employee_id": emp_id,
            "employee_name": emp.get("name", ""),
            "department": emp.get("department", "General"),
            "year": year,
            "month": month,
            "ctc_annual": ctc,
            "working_days": working_days,
            "present_days": present_days,
            "loss_of_pay_days": loss_of_pay_days,
            "earnings": breakdown["earnings"],
            "deductions": breakdown["deductions"],
            "lop_deduction": round(lop_deduction, 2),
            "gross_salary": round(monthly_gross, 2),
            "total_deductions": round(breakdown["monthly_deductions"] + lop_deduction, 2),
            "net_salary": round(max(0, net_salary), 2),
            "generated_at": datetime.now(timezone.utc),
            "status": "generated",
        }
        payslips.append(payslip)
        total_gross += monthly_gross
        total_net += net_salary
        total_deductions += breakdown["monthly_deductions"] + lop_deduction

    # Save payslips
    if payslips:
        db.payslips.insert_many(payslips)

    # Save payroll run record
    run_record = {
        "year": year,
        "month": month,
        "department": department,
        "company_id": company_id or None,
        "employee_count": len(payslips),
        "total_gross": round(total_gross, 2),
        "total_deductions": round(total_deductions, 2),
        "total_net": round(total_net, 2),
        "status": "completed",
        "run_by": getattr(g, "admin_claims", {}).get("sub", "admin") if hasattr(g, "admin_claims") else "admin",
        "run_at": datetime.now(timezone.utc),
    }
    db.payroll_runs.insert_one(run_record)
    run_record.pop("_id", None)

    try:
        persist_fn = current_app.config.get("persist_mock_db")
        if callable(persist_fn):
            persist_fn()
    except Exception:
        pass

    return jsonify({
        "message": f"Payroll completed for {year}-{month:02d}",
        "summary": _to_json_safe(run_record),
        "payslip_count": len(payslips),
    })


@payroll_bp.route("/api/payroll/payslips", methods=["GET"])
def list_payslips():
    """List payslips filtered by year/month/employee."""
    db = _get_db()
    if db is None:
        return jsonify([])

    year = request.args.get("year", type=int)
    month = request.args.get("month", type=int)
    employee_id = request.args.get("employee_id", "")

    query = {}
    if year:
        query["year"] = year
    if month:
        query["month"] = month
    if employee_id:
        query["employee_id"] = employee_id

    payslips = list(db.payslips.find(query).sort([("year", -1), ("month", -1)]).limit(200))
    for p in payslips:
        p["_id"] = str(p["_id"])
    return jsonify(_to_json_safe(payslips))


@payroll_bp.route("/api/payroll/payslips/<payslip_id>", methods=["GET"])
def get_payslip(payslip_id):
    """Get a specific payslip."""
    db = _get_db()
    if db is None:
        return jsonify({"message": "Database not available"}), 503
    try:
        payslip = db.payslips.find_one({"_id": ObjectId(payslip_id)})
    except (InvalidId, Exception):
        return jsonify({"message": "Invalid payslip ID"}), 400
    if not payslip:
        return jsonify({"message": "Payslip not found"}), 404
    payslip["_id"] = str(payslip["_id"])
    return jsonify(_to_json_safe(payslip))


@payroll_bp.route("/api/payroll/runs", methods=["GET"])
def list_payroll_runs():
    """List all payroll runs."""
    db = _get_db()
    if db is None:
        return jsonify([])
    runs = list(db.payroll_runs.find({}).sort([("year", -1), ("month", -1)]))
    for r in runs:
        r["_id"] = str(r["_id"])
    return jsonify(_to_json_safe(runs))


# ==================== Helpers ====================

def _calculate_salary_breakdown(annual_ctc: float) -> dict:
    """Calculate monthly salary breakdown from annual CTC."""
    monthly_ctc = annual_ctc / 12
    basic = monthly_ctc * 0.40
    hra = basic * 0.50
    conveyance = min(1600, monthly_ctc * 0.05)
    medical = min(1250, monthly_ctc * 0.04)
    special = monthly_ctc - basic - hra - conveyance - medical

    # Earnings
    earnings = [
        {"code": "BASIC", "name": "Basic Salary", "amount": round(basic, 2)},
        {"code": "HRA", "name": "House Rent Allowance", "amount": round(hra, 2)},
        {"code": "CONV", "name": "Conveyance Allowance", "amount": round(conveyance, 2)},
        {"code": "MED", "name": "Medical Allowance", "amount": round(medical, 2)},
        {"code": "SPEC", "name": "Special Allowance", "amount": round(max(0, special), 2)},
    ]
    gross = sum(e["amount"] for e in earnings)

    # Deductions
    pf = round(basic * 0.12, 2)
    esi = round(gross * 0.0075, 2) if gross <= 21000 else 0
    pt = 200 if gross > 15000 else 150 if gross > 10000 else 0
    tds = 0  # Placeholder — calculated separately

    deductions = [
        {"code": "PF", "name": "Provident Fund", "amount": pf},
        {"code": "ESI", "name": "ESI", "amount": esi},
        {"code": "PT", "name": "Professional Tax", "amount": pt},
        {"code": "TDS", "name": "Income Tax (TDS)", "amount": tds},
    ]
    total_deductions = sum(d["amount"] for d in deductions)

    return {
        "annual_ctc": annual_ctc,
        "monthly_ctc": round(monthly_ctc, 2),
        "earnings": earnings,
        "deductions": deductions,
        "monthly_gross": round(gross, 2),
        "monthly_deductions": round(total_deductions, 2),
        "monthly_net": round(gross - total_deductions, 2),
        "employer_pf": round(basic * 0.12, 2),  # Employer PF contribution
    }


def _get_working_days(year: int, month: int, days_in_month: int) -> int:
    """Get number of working days (excluding weekends) in a month."""
    count = 0
    for day in range(1, days_in_month + 1):
        d = date(year, month, day)
        if d.weekday() < 5:  # Mon-Fri
            count += 1
    return count


def _get_present_days(db, employee_id: str, year: int, month: int) -> int:
    """Get number of days an employee was present in a given month."""
    start_date = f"{year}-{month:02d}-01"
    _, last_day = monthrange(year, month)
    end_date = f"{year}-{month:02d}-{last_day:02d}"

    count = db.attendance.count_documents({
        "employee_id": employee_id,
        "date": {"$gte": start_date, "$lte": end_date},
        "status": {"$in": ["checked_in", "checked_out", "present"]},
    })
    return count
