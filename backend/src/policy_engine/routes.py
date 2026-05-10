from __future__ import annotations

import uuid
from datetime import date, datetime

from flask import Blueprint, current_app, g, jsonify, request
from sqlalchemy import and_, desc, select

from src.security import admin_auth_required

from .database import get_session
from .models import AttendancePolicy, PolicyAssignment
from .service import (
    assignment_to_dict,
    calculate_attendance,
    policy_to_dict,
    resolve_policy_for_employee,
)

policy_blueprint = Blueprint("policy_engine", __name__)

_VALID_SCOPE_TYPES = {"company", "department", "role", "employee"}
_VALID_SHIFT_TYPES = {"general", "night", "custom"}
_VALID_WEEKEND_DAYS = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}


def _parse_date(value: str, field: str) -> date:
    text = str(value or "").strip()
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        raise ValueError(f"Invalid {field}. Expected YYYY-MM-DD")


def _parse_policy_payload(payload: dict, *, for_update: bool = False) -> dict:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("Policy name is required")

    shift_type = str(payload.get("shiftType") or "general").strip().lower()
    if shift_type not in _VALID_SHIFT_TYPES:
        raise ValueError("shiftType must be one of: general, night, custom")

    shift_start = str(payload.get("shiftStart") or "09:00").strip()
    try:
        datetime.strptime(shift_start, "%H:%M")
    except ValueError:
        raise ValueError("shiftStart must be HH:MM")

    late_grace_minutes = int(payload.get("lateGraceMinutes", 15))
    half_day_hours = float(payload.get("halfDayHours", 4))
    full_day_hours = float(payload.get("fullDayHours", 8))
    absent_cutoff_hour = int(payload.get("absentCutoffHour", 10))

    if late_grace_minutes < 0 or late_grace_minutes > 180:
        raise ValueError("lateGraceMinutes must be between 0 and 180")
    if half_day_hours <= 0:
        raise ValueError("halfDayHours must be greater than 0")
    if full_day_hours <= half_day_hours:
        raise ValueError("fullDayHours must be greater than halfDayHours")
    if absent_cutoff_hour < 0 or absent_cutoff_hour > 23:
        raise ValueError("absentCutoffHour must be between 0 and 23")

    effective_from = _parse_date(payload.get("effectiveFrom") or date.today().isoformat(), "effectiveFrom")
    weekend_allowed = bool(payload.get("weekendAllowed", False))

    weekend_days_raw = payload.get("weekendDays")
    weekend_days = weekend_days_raw if isinstance(weekend_days_raw, list) else ["sat", "sun"]
    weekend_days = [str(x).strip().lower() for x in weekend_days if str(x).strip()]
    if not set(weekend_days).issubset(_VALID_WEEKEND_DAYS):
        raise ValueError("weekendDays can contain only mon,tue,wed,thu,fri,sat,sun")

    return {
        "name": name,
        "shift_type": shift_type,
        "shift_start": shift_start,
        "late_grace_minutes": late_grace_minutes,
        "half_day_hours": half_day_hours,
        "full_day_hours": full_day_hours,
        "absent_cutoff_hour": absent_cutoff_hour,
        "weekend_allowed": weekend_allowed,
        "weekend_days": weekend_days,
        "holiday_calendar_key": str(payload.get("holidayCalendarKey") or "").strip() or None,
        "effective_from": effective_from,
        "is_active": bool(payload.get("isActive", True)) if for_update else True,
    }


@policy_blueprint.post("/policies")
@admin_auth_required
def create_policy():
    payload = request.get_json(silent=True) or {}
    try:
        parsed = _parse_policy_payload(payload)
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    created_by = str(getattr(g, "admin_claims", {}).get("username") or "admin")
    policy_group_id = str(uuid.uuid4())

    with get_session() as session:
        row = AttendancePolicy(
            policy_group_id=policy_group_id,
            version=1,
            created_by=created_by,
            **parsed,
        )
        session.add(row)
        session.flush()
        return jsonify({"message": "Policy created", "policy": policy_to_dict(row)}), 201


@policy_blueprint.get("/policies")
@admin_auth_required
def list_policies():
    include_versions = str(request.args.get("includeVersions") or "false").strip().lower() in {"1", "true", "yes", "on"}
    active_only = str(request.args.get("activeOnly") or "true").strip().lower() in {"1", "true", "yes", "on"}

    with get_session() as session:
        if include_versions:
            query = select(AttendancePolicy)
            if active_only:
                query = query.where(AttendancePolicy.is_active.is_(True))
            query = query.order_by(desc(AttendancePolicy.effective_from), desc(AttendancePolicy.created_at))
            rows = session.execute(query).scalars().all()
            return jsonify({"items": [policy_to_dict(row) for row in rows], "total": len(rows)})

        # latest version per group
        groups = session.execute(
            select(AttendancePolicy.policy_group_id)
            .group_by(AttendancePolicy.policy_group_id)
        ).scalars().all()

        items = []
        for group_id in groups:
            q = (
                select(AttendancePolicy)
                .where(AttendancePolicy.policy_group_id == group_id)
                .order_by(desc(AttendancePolicy.version), desc(AttendancePolicy.created_at))
                .limit(1)
            )
            row = session.execute(q).scalar_one_or_none()
            if not row:
                continue
            if active_only and not row.is_active:
                continue
            items.append(policy_to_dict(row))

        items.sort(key=lambda item: (item.get("effectiveFrom") or "", item.get("createdAt") or ""), reverse=True)
        return jsonify({"items": items, "total": len(items)})


@policy_blueprint.put("/policies/<policy_id>")
@admin_auth_required
def update_policy(policy_id: str):
    payload = request.get_json(silent=True) or {}
    try:
        parsed = _parse_policy_payload(payload, for_update=True)
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    created_by = str(getattr(g, "admin_claims", {}).get("username") or "admin")

    with get_session() as session:
        current = session.get(AttendancePolicy, policy_id)
        if not current:
            return jsonify({"message": "Policy not found"}), 404

        latest_same_group = session.execute(
            select(AttendancePolicy)
            .where(AttendancePolicy.policy_group_id == current.policy_group_id)
            .order_by(desc(AttendancePolicy.version))
            .limit(1)
        ).scalar_one_or_none()
        next_version = int((latest_same_group.version if latest_same_group else current.version) + 1)

        new_row = AttendancePolicy(
            policy_group_id=current.policy_group_id,
            version=next_version,
            created_by=created_by,
            **parsed,
        )
        session.add(new_row)
        session.flush()

        return jsonify({
            "message": "Policy version created",
            "policy": policy_to_dict(new_row),
            "previousPolicyId": current.id,
        })


@policy_blueprint.delete("/policies/<policy_id>")
@admin_auth_required
def delete_policy(policy_id: str):
    with get_session() as session:
        row = session.get(AttendancePolicy, policy_id)
        if not row:
            return jsonify({"message": "Policy not found"}), 404
        row.is_active = False
        session.add(row)
        return jsonify({"message": "Policy archived", "policy": policy_to_dict(row)})


@policy_blueprint.post("/policies/assign")
@admin_auth_required
def assign_policy():
    payload = request.get_json(silent=True) or {}
    policy_id = str(payload.get("policyId") or "").strip()
    scope_type = str(payload.get("scopeType") or "").strip().lower()
    scope_value = str(payload.get("scopeValue") or "").strip()

    if not policy_id:
        return jsonify({"message": "policyId is required"}), 400
    if scope_type not in _VALID_SCOPE_TYPES:
        return jsonify({"message": "scopeType must be one of company, department, role, employee"}), 400
    if scope_type == "company":
        scope_value = "*"
    elif not scope_value:
        return jsonify({"message": "scopeValue is required for this scopeType"}), 400

    try:
        effective_from = _parse_date(payload.get("effectiveFrom") or date.today().isoformat(), "effectiveFrom")
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    created_by = str(getattr(g, "admin_claims", {}).get("username") or "admin")

    with get_session() as session:
        policy = session.get(AttendancePolicy, policy_id)
        if not policy or not policy.is_active:
            return jsonify({"message": "Policy not found or inactive"}), 404

        row = PolicyAssignment(
            policy_id=policy_id,
            scope_type=scope_type,
            scope_value=scope_value,
            effective_from=effective_from,
            created_by=created_by,
        )
        session.add(row)
        session.flush()
        return jsonify({"message": "Policy assignment created", "assignment": assignment_to_dict(row)})


@policy_blueprint.get("/policies/employee/<employee_id>")
@admin_auth_required
def get_employee_policy(employee_id: str):
    mongo_db = current_app.config.get("MONGO_DB")
    if mongo_db is None:
        return jsonify({"message": "Mongo database not configured"}), 500

    from bson import ObjectId
    from bson.errors import InvalidId

    employee = None
    try:
        employee = mongo_db.employees.find_one({"_id": ObjectId(employee_id)})
    except InvalidId:
        employee = None

    if not employee:
        return jsonify({"message": "Employee not found"}), 404

    target_date_text = str(request.args.get("date") or date.today().isoformat())
    try:
        target_date = _parse_date(target_date_text, "date")
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    with get_session() as session:
        resolved = resolve_policy_for_employee(
            session,
            employee_id=str(employee.get("_id")),
            department=str(employee.get("department") or ""),
            role=str(employee.get("role") or ""),
            on_date=target_date,
        )
        if not resolved:
            return jsonify({"message": "No policy configured"}), 404

        return jsonify({
            "employee": {
                "id": str(employee.get("_id")),
                "name": str(employee.get("name") or ""),
                "department": str(employee.get("department") or ""),
                "role": str(employee.get("role") or ""),
            },
            "resolvedBy": resolved.resolved_by,
            "resolvedValue": resolved.resolved_value,
            "policy": policy_to_dict(resolved.policy),
        })


@policy_blueprint.post("/policies/test")
@admin_auth_required
def test_policy_engine():
    payload = request.get_json(silent=True) or {}
    policy_payload = payload.get("policy") or {}
    check_in_text = str(payload.get("checkIn") or "").strip()
    check_out_text = str(payload.get("checkOut") or "").strip()

    if not check_in_text:
        return jsonify({"message": "checkIn is required"}), 400

    try:
        # Accept full ISO or HH:MM forms.
        if "T" in check_in_text:
            check_in_dt = datetime.fromisoformat(check_in_text.replace("Z", "+00:00"))
        else:
            check_in_dt = datetime.fromisoformat(f"{date.today().isoformat()}T{check_in_text}:00")

        if check_out_text:
            if "T" in check_out_text:
                check_out_dt = datetime.fromisoformat(check_out_text.replace("Z", "+00:00"))
            else:
                check_out_dt = datetime.fromisoformat(f"{check_in_dt.date().isoformat()}T{check_out_text}:00")
        else:
            check_out_dt = None
    except Exception:
        return jsonify({"message": "Invalid checkIn/checkOut. Use ISO or HH:MM format."}), 400

    result = calculate_attendance(policy_payload, check_in_dt, check_out_dt)
    return jsonify({"result": result})
