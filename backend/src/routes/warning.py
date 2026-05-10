from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from bson import ObjectId
from bson.errors import InvalidId
from flask import Blueprint, jsonify, request

from src.models.warning import WarningRepository
from src.services.email_service import send_warning_email
from src.utils.attendance_helper import late_stats_last_7_days


def _resolve_employee(db, employee_id_raw: Any) -> Optional[dict]:
    if employee_id_raw is None:
        return None

    text = str(employee_id_raw).strip()
    if not text:
        return None

    try:
        oid = ObjectId(text)
        row = db.employees.find_one({"_id": oid})
        if row:
            return row
    except (InvalidId, TypeError):
        pass

    candidates = [{"id": text}, {"login_id": text.lower()}]
    try:
        num = int(text)
        candidates.append({"id": num})
        candidates.append({"employee_id": num})
    except (TypeError, ValueError):
        pass

    return db.employees.find_one({"$or": candidates})


def _warning_reason(raw_reason: Any) -> str:
    reason = str(raw_reason or "Late attendance").strip()
    if len(reason) > 220:
        reason = reason[:220]
    return reason or "Late attendance"


def _issue_warning(
    *,
    db,
    repo: WarningRepository,
    employee: dict,
    reason: str,
    auto_generated: bool,
    late_cutoff_hour: int,
    late_cutoff_minute: int,
) -> Dict[str, Any]:
    stats = late_stats_last_7_days(
        db.attendance,
        employee.get("_id"),
        late_cutoff_hour=late_cutoff_hour,
        late_cutoff_minute=late_cutoff_minute,
    )

    late_count = int(stats.get("late_count") or 0)
    latest_delay = int(stats.get("latest_delay") or 0)
    name = str(employee.get("name") or "Employee").strip() or "Employee"
    email = str(employee.get("email") or "").strip().lower()

    sent, email_error, provider = send_warning_email(name, email, late_count, latest_delay)
    if not sent:
        return {
            "ok": False,
            "status": 502,
            "message": f"Failed to send warning email: {email_error}",
            "data": None,
        }

    warning = repo.insert_warning(
        {
            "employee_id": employee.get("_id"),
            "reason": reason,
            "late_count": late_count,
            "latest_delay": latest_delay,
            "auto_generated": bool(auto_generated),
            "email_provider": provider,
            "employee_name": name,
            "employee_email": email,
        }
    )

    return {
        "ok": True,
        "status": 200,
        "message": "Warning email sent",
        "data": {
            "warning": warning,
            "late_count": late_count,
            "latest_delay": latest_delay,
            "employee": {
                "id": str(employee.get("_id")),
                "name": name,
                "email": email,
            },
        },
    }


def create_warning_blueprint(
    *,
    db,
    admin_auth_decorator=None,
    persist_callback=None,
    logger=None,
    notification_callback=None,
    audit_callback=None,
) -> Blueprint:
    repo = WarningRepository(db)
    repo.ensure_indexes()
    bp = Blueprint("warning_api", __name__)

    late_cutoff_hour = int(str(os.getenv("ATTENDANCE_LATE_CUTOFF_HOUR", "9")).strip() or "9")
    late_cutoff_minute = int(str(os.getenv("ATTENDANCE_LATE_CUTOFF_MINUTE", "30")).strip() or "30")

    def _run_warn_for_employee(employee: dict, reason: str, auto_generated: bool = False) -> Dict[str, Any]:
        result = _issue_warning(
            db=db,
            repo=repo,
            employee=employee,
            reason=reason,
            auto_generated=auto_generated,
            late_cutoff_hour=late_cutoff_hour,
            late_cutoff_minute=late_cutoff_minute,
        )
        if result.get("ok") and callable(persist_callback):
            try:
                persist_callback()
            except Exception:
                pass

        if result.get("ok") and callable(notification_callback):
            try:
                payload = result.get("data") or {}
                employee_name = (payload.get('employee') or {}).get('name') or 'you'
                employee_id = str((payload.get("employee") or {}).get("id") or "")
                notification_callback(
                    f"A formal attendance warning has been issued to your account due to repeated late check-ins. Please ensure punctuality going forward.",
                    "attendance",
                    employee_id,
                    title="Attendance Warning",
                    priority="high",
                    category="late_attendance_warning",
                )
            except Exception:
                pass

        if result.get("ok") and callable(audit_callback):
            try:
                payload = result.get("data") or {}
                audit_callback(
                    "warn_employee_email",
                    target={"employee_id": (payload.get("employee") or {}).get("id")},
                    details={
                        "reason": reason,
                        "late_count": payload.get("late_count"),
                        "latest_delay": payload.get("latest_delay"),
                        "auto_generated": bool(auto_generated),
                    },
                )
            except Exception:
                pass

        return result

    def warn_employee_handler():
        payload = request.get_json(silent=True) or {}
        employee_id = payload.get("employeeId")
        reason = _warning_reason(payload.get("reason"))

        employee = _resolve_employee(db, employee_id)
        if not employee:
            return jsonify({"message": "Employee not found"}), 404

        result = _run_warn_for_employee(employee, reason, auto_generated=False)
        if not result.get("ok"):
            return jsonify({"message": result.get("message")}), int(result.get("status") or 400)
        return jsonify({"message": result.get("message"), **(result.get("data") or {})}), 200

    def warning_history_handler():
        employee_id = request.args.get("employeeId") or request.args.get("employee_id")
        if not employee_id:
            return jsonify({"message": "employeeId is required"}), 400
        employee = _resolve_employee(db, employee_id)
        if not employee:
            return jsonify({"message": "Employee not found"}), 404
        try:
            limit = int(request.args.get("limit") or 25)
        except (TypeError, ValueError):
            limit = 25

        rows = repo.list_history(employee.get("_id"), limit=limit)
        return jsonify({"employee_id": str(employee.get("_id")), "items": rows, "total": len(rows)})

    def warning_counts_handler():
        company_id = str(request.args.get("company_id") or "").strip()
        items = repo.warning_counts()
        if not company_id:
            return jsonify({"items": items})
        from src.utils.company_scope import list_company_employee_id_strings

        allowed = set(list_company_employee_id_strings(db, company_id))
        filtered = [row for row in items if str(row.get("employee_id") or "") in allowed]
        return jsonify({"items": filtered})

    if admin_auth_decorator:
        warn_view = admin_auth_decorator(warn_employee_handler)
        history_view = admin_auth_decorator(warning_history_handler)
        counts_view = admin_auth_decorator(warning_counts_handler)
    else:
        warn_view = warn_employee_handler
        history_view = warning_history_handler
        counts_view = warning_counts_handler

    bp.add_url_rule("/api/warn-employee", view_func=warn_view, methods=["POST"])
    bp.add_url_rule("/api/warn-employee/history", view_func=history_view, methods=["GET"])
    bp.add_url_rule("/api/warn-employee/counts", view_func=counts_view, methods=["GET"])

    bp.issue_warning_for_employee = _run_warn_for_employee
    bp.warning_repository = repo
    bp.warning_late_cutoff = (late_cutoff_hour, late_cutoff_minute)
    return bp


_scheduler_lock = threading.Lock()
_scheduler_started = False


def start_warning_scheduler(db, warning_blueprint, logger=None):
    global _scheduler_started

    enabled = str(os.getenv("WARNING_AUTO_ENABLED", "true")).strip().lower() in {"1", "true", "yes", "on"}
    if not enabled:
        return False

    with _scheduler_lock:
        if _scheduler_started:
            return False
        _scheduler_started = True

    interval_minutes = max(5, int(str(os.getenv("WARNING_AUTO_INTERVAL_MINUTES", "1440")).strip() or "1440"))
    late_threshold = max(1, int(str(os.getenv("WARNING_AUTO_LATE_THRESHOLD", "3")).strip() or "3"))
    auto_reason = str(os.getenv("WARNING_AUTO_REASON", "Late attendance")).strip() or "Late attendance"

    cutoff_hour, cutoff_minute = getattr(warning_blueprint, "warning_late_cutoff", (9, 30))
    issue_warning_for_employee = getattr(warning_blueprint, "issue_warning_for_employee", None)
    repo = getattr(warning_blueprint, "warning_repository", None)

    if not callable(issue_warning_for_employee) or repo is None:
        return False

    def _run_once():
        active_rows = list(
            db.employees.find(
                {
                    "$or": [
                        {"status": {"$ne": "inactive"}},
                        {"is_active": True},
                        {"active": True},
                    ]
                },
                {"_id": 1, "name": 1, "email": 1},
            )
        )

        for employee in active_rows:
            stats = late_stats_last_7_days(
                db.attendance,
                employee.get("_id"),
                reference_utc=datetime.now(timezone.utc),
                late_cutoff_hour=cutoff_hour,
                late_cutoff_minute=cutoff_minute,
            )
            late_count = int(stats.get("late_count") or 0)
            if late_count <= late_threshold:
                continue
            if repo.has_auto_warning_today(employee.get("_id"), auto_reason):
                continue
            result = issue_warning_for_employee(employee, auto_reason, auto_generated=True)
            if logger and result.get("ok"):
                try:
                    logger.info(
                        "auto_warning_sent",
                        extra={
                            "event": "auto_warning_sent",
                            "employee_id": str(employee.get("_id")),
                            "late_count": late_count,
                        },
                    )
                except Exception:
                    pass

    def _loop():
        # Initial delay to avoid startup contention.
        time.sleep(12)
        while True:
            try:
                _run_once()
            except Exception as exc:
                if logger:
                    try:
                        logger.warning(
                            "auto_warning_failed",
                            extra={"event": "auto_warning_failed", "error": str(exc)},
                        )
                    except Exception:
                        pass
            time.sleep(interval_minutes * 60)

    worker = threading.Thread(target=_loop, name="warning-auto-scheduler", daemon=True)
    worker.start()
    return True
