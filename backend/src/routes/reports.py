# ==========================================================================
# Item 9: Analytics & Reports with PDF Export
# Provides advanced analytics endpoints and server-side PDF generation.
# ==========================================================================
import io
import json
from datetime import datetime, timezone, date, timedelta
from calendar import monthrange
from flask import Blueprint, g, jsonify, request, Response

reports_bp = Blueprint("reports_v2", __name__)


def _attendance_employee_ids_mongo_clause(employee_id_strings):
    """Match attendance rows stored with string or ObjectId employee_id."""
    from bson import ObjectId
    from bson.errors import InvalidId

    clauses = []
    for raw in employee_id_strings or []:
        sid = str(raw)
        clauses.append(sid)
        try:
            clauses.append(ObjectId(sid))
        except (InvalidId, TypeError):
            pass
    return {"$in": clauses}


def _get_db():
    from flask import current_app
    return current_app.config.get("_db")


# ==================== Attendance Analytics ====================

@reports_bp.route("/api/analytics/attendance-summary", methods=["GET"])
def attendance_summary():
    """Comprehensive attendance analytics for a date range."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    from_date = request.args.get("from_date", "")
    to_date = request.args.get("to_date", "")
    department = request.args.get("department", "")

    if not from_date or not to_date:
        today = date.today()
        from_date = today.replace(day=1).isoformat()
        to_date = today.isoformat()

    # Employee query
    emp_query = {"status": {"$in": ["active", "probation"]}}
    if department:
        emp_query["department"] = department
    employees = list(db.employees.find(emp_query, {"_id": 1, "name": 1, "department": 1}))
    emp_ids = [str(e["_id"]) for e in employees]
    total_employees = len(emp_ids)

    # Attendance records (supports ObjectId employee_id stored in Mongo)
    att_query = {"date": {"$gte": from_date, "$lte": to_date}}
    if emp_ids:
        att_query["employee_id"] = _attendance_employee_ids_mongo_clause(emp_ids)
    records = list(db.attendance.find(att_query))

    # Count by status
    present_count = sum(1 for r in records if r.get("status") in ["checked_in", "checked_out", "present"])
    late_count = sum(1 for r in records if r.get("timing_status") == "late")
    early_departure_count = sum(1 for r in records if r.get("timing_status") == "early_departure")

    # Department breakdown
    dept_stats = {}
    for emp in employees:
        dept = emp.get("department", "General")
        if dept not in dept_stats:
            dept_stats[dept] = {"total": 0, "present": 0, "absent": 0, "late": 0}
        dept_stats[dept]["total"] += 1

    for rec in records:
        emp_rec_id = rec.get("employee_id", "")
        emp = next((e for e in employees if str(e["_id"]) == str(emp_rec_id)), None)
        if emp:
            dept = emp.get("department", "General")
            if rec.get("status") in ["checked_in", "checked_out", "present"]:
                dept_stats.get(dept, {})["present"] = dept_stats.get(dept, {}).get("present", 0) + 1
            if rec.get("timing_status") == "late":
                dept_stats.get(dept, {})["late"] = dept_stats.get(dept, {}).get("late", 0) + 1

    # Daily trend
    daily_trend = {}
    for rec in records:
        d = rec.get("date", "")
        if d not in daily_trend:
            daily_trend[d] = {"date": d, "present": 0, "absent": 0, "late": 0}
        if rec.get("status") in ["checked_in", "checked_out", "present"]:
            daily_trend[d]["present"] += 1
        if rec.get("timing_status") == "late":
            daily_trend[d]["late"] += 1

    # Calculate working days
    try:
        start = datetime.strptime(from_date, "%Y-%m-%d").date()
        end = datetime.strptime(to_date, "%Y-%m-%d").date()
        working_days = sum(1 for i in range((end - start).days + 1)
                          if (start + timedelta(days=i)).weekday() < 5)
    except Exception:
        working_days = 0

    return jsonify({
        "period": {"from_date": from_date, "to_date": to_date},
        "total_employees": total_employees,
        "working_days": working_days,
        "total_attendance_records": len(records),
        "present_count": present_count,
        "late_count": late_count,
        "early_departure_count": early_departure_count,
        "attendance_rate": round((present_count / max(1, total_employees * working_days)) * 100, 1),
        "punctuality_rate": round(((present_count - late_count) / max(1, present_count)) * 100, 1),
        "department_breakdown": dept_stats,
        "daily_trend": sorted(daily_trend.values(), key=lambda x: x["date"]),
    })


# ==================== Employee Performance Report ====================

@reports_bp.route("/api/analytics/employee-performance", methods=["GET"])
def employee_performance():
    """Individual employee performance report."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    employee_id = request.args.get("employee_id", "")
    from_date = request.args.get("from_date", "")
    to_date = request.args.get("to_date", "")

    if not employee_id:
        return jsonify({"message": "employee_id is required"}), 400

    if not from_date or not to_date:
        today = date.today()
        from_date = (today - timedelta(days=30)).isoformat()
        to_date = today.isoformat()

    # Attendance data (stored employee_id may be ObjectId or string)
    records = list(db.attendance.find({
        "employee_id": _attendance_employee_ids_mongo_clause([employee_id]),
        "date": {"$gte": from_date, "$lte": to_date},
    }).sort("date", 1))

    present = sum(1 for r in records if r.get("status") in ["checked_in", "checked_out", "present"])
    late = sum(1 for r in records if r.get("timing_status") == "late")

    # Task data
    tasks = list(db.tasks.find({
        "assigned_to": employee_id,
        "created_at": {"$gte": from_date},
    }))
    tasks_completed = sum(1 for t in tasks if t.get("status") in ["completed", "approved"])

    # Average working hours
    total_hours = 0
    for rec in records:
        ci = rec.get("check_in_time") or rec.get("check_in", "")
        co = rec.get("check_out_time") or rec.get("check_out", "")
        if ci and co:
            try:
                ci_dt = datetime.strptime(str(ci)[:5], "%H:%M")
                co_dt = datetime.strptime(str(co)[:5], "%H:%M")
                hours = (co_dt - ci_dt).total_seconds() / 3600
                if hours > 0:
                    total_hours += hours
            except Exception:
                pass
    avg_hours = round(total_hours / max(1, present), 1)

    return jsonify({
        "employee_id": employee_id,
        "period": {"from_date": from_date, "to_date": to_date},
        "attendance": {
            "total_days": len(records),
            "present": present,
            "late": late,
            "absent": max(0, len(records) - present),
            "attendance_rate": round((present / max(1, len(records))) * 100, 1),
            "punctuality_rate": round(((present - late) / max(1, present)) * 100, 1),
        },
        "tasks": {
            "total": len(tasks),
            "completed": tasks_completed,
            "completion_rate": round((tasks_completed / max(1, len(tasks))) * 100, 1),
        },
        "working_hours": {
            "total": round(total_hours, 1),
            "average_daily": avg_hours,
        },
    })


# ==================== PDF Report Generation ====================

@reports_bp.route("/api/reports/export/pdf", methods=["POST"])
def export_pdf_report():
    """
    Generate a PDF report. Uses simple HTML-to-text approach.
    For production, integrate weasyprint or reportlab.
    """
    payload = request.get_json(silent=True) or {}
    report_type = payload.get("type", "attendance")
    title = payload.get("title", f"HRMS {report_type.title()} Report")
    data = payload.get("data", {})

    # Build a simple text-based PDF content
    lines = []
    lines.append(f"{'=' * 60}")
    lines.append(f"  {title}")
    lines.append(f"  Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"{'=' * 60}")
    lines.append("")

    if report_type == "attendance":
        period = data.get("period", {})
        lines.append(f"  Period: {period.get('from_date', 'N/A')} to {period.get('to_date', 'N/A')}")
        lines.append(f"  Total Employees: {data.get('total_employees', 0)}")
        lines.append(f"  Attendance Rate: {data.get('attendance_rate', 0)}%")
        lines.append(f"  Present: {data.get('present_count', 0)}")
        lines.append(f"  Late: {data.get('late_count', 0)}")
        lines.append("")
        lines.append(f"  {'Department':<20} {'Total':<10} {'Present':<10} {'Late':<10}")
        lines.append(f"  {'-' * 50}")
        for dept, stats in data.get("department_breakdown", {}).items():
            lines.append(f"  {dept:<20} {stats.get('total', 0):<10} {stats.get('present', 0):<10} {stats.get('late', 0):<10}")

    elif report_type == "payroll":
        lines.append(f"  Month: {data.get('year', '')}-{data.get('month', ''):02d}")
        lines.append(f"  Employees: {data.get('employee_count', 0)}")
        lines.append(f"  Total Gross: ₹{data.get('total_gross', 0):,.2f}")
        lines.append(f"  Total Deductions: ₹{data.get('total_deductions', 0):,.2f}")
        lines.append(f"  Total Net: ₹{data.get('total_net', 0):,.2f}")

    elif report_type == "employee":
        att = data.get("attendance", {})
        tasks = data.get("tasks", {})
        lines.append(f"  Attendance Rate: {att.get('attendance_rate', 0)}%")
        lines.append(f"  Punctuality Rate: {att.get('punctuality_rate', 0)}%")
        lines.append(f"  Task Completion: {tasks.get('completion_rate', 0)}%")
        lines.append(f"  Avg Daily Hours: {data.get('working_hours', {}).get('average_daily', 0)}")

    else:
        lines.append("  Report data:")
        lines.append(f"  {json.dumps(data, indent=2, default=str)}")

    lines.append("")
    lines.append(f"{'=' * 60}")
    lines.append("  Generated by PRHR - Face Recognition Attendance System")
    lines.append(f"{'=' * 60}")

    content = "\n".join(lines)

    return Response(
        content,
        mimetype="text/plain",
        headers={
            "Content-Disposition": f"attachment; filename={report_type}_report_{datetime.now().strftime('%Y%m%d')}.txt",
        },
    )


# ==================== Dashboard Widgets ====================

@reports_bp.route("/api/analytics/widgets", methods=["GET"])
def dashboard_widgets():
    """Pre-computed widget data for dashboard."""
    db = _get_db()
    if not db:
        return jsonify({"widgets": []})

    today = date.today().isoformat()
    employees = list(db.employees.find({"status": {"$in": ["active", "probation"]}}, {"_id": 1}))
    total = len(employees)

    today_attendance = list(db.attendance.find({"date": today}))
    present = sum(1 for r in today_attendance if r.get("status") in ["checked_in", "checked_out", "present"])
    late = sum(1 for r in today_attendance if r.get("timing_status") == "late")

    pending_leaves = db.leave_requests_v2.count_documents({"status": "pending"}) if hasattr(db, "leave_requests_v2") else 0
    pending_tasks = db.tasks.count_documents({"status": "pending"}) if hasattr(db, "tasks") else 0

    return jsonify({
        "widgets": [
            {"key": "total_employees", "label": "Total Employees", "value": total, "icon": "users", "color": "#3b82f6"},
            {"key": "present_today", "label": "Present Today", "value": present, "icon": "check-circle", "color": "#22c55e"},
            {"key": "absent_today", "label": "Absent Today", "value": max(0, total - present), "icon": "x-circle", "color": "#ef4444"},
            {"key": "late_today", "label": "Late Today", "value": late, "icon": "clock", "color": "#f59e0b"},
            {"key": "pending_leaves", "label": "Pending Leaves", "value": pending_leaves, "icon": "calendar", "color": "#8b5cf6"},
            {"key": "pending_tasks", "label": "Pending Tasks", "value": pending_tasks, "icon": "list-todo", "color": "#06b6d4"},
        ],
    })
