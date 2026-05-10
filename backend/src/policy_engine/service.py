from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import and_, desc, select
from sqlalchemy.orm import Session

from .models import AttendancePolicy, PolicyAssignment


_SCOPE_PRIORITY = {
    "employee": 4,
    "role": 3,
    "department": 2,
    "company": 1,
}


@dataclass
class ResolvedPolicy:
    policy: AttendancePolicy
    resolved_by: str
    resolved_value: str


def _parse_hhmm(value: str) -> time:
    text = str(value or "").strip()
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).time()
        except ValueError:
            continue
    raise ValueError("Invalid time format. Expected HH:MM or HH:MM:SS")


def _combine_with_checkin_date(check_in_dt: datetime, hhmm: str) -> datetime:
    t = _parse_hhmm(hhmm)
    return datetime.combine(check_in_dt.date(), t)


def _safe_hours(check_in_dt: datetime | None, check_out_dt: datetime | None) -> float:
    if not check_in_dt or not check_out_dt:
        return 0.0
    delta = check_out_dt - check_in_dt
    if delta.total_seconds() < 0:
        delta += timedelta(days=1)
    return round(max(0.0, delta.total_seconds() / 3600.0), 2)


def policy_to_dict(policy: AttendancePolicy) -> dict[str, Any]:
    return {
        "id": policy.id,
        "policyGroupId": policy.policy_group_id,
        "version": int(policy.version),
        "name": policy.name,
        "shiftType": policy.shift_type,
        "shiftStart": policy.shift_start,
        "lateGraceMinutes": int(policy.late_grace_minutes),
        "halfDayHours": float(policy.half_day_hours),
        "fullDayHours": float(policy.full_day_hours),
        "absentCutoffHour": int(policy.absent_cutoff_hour),
        "weekendAllowed": bool(policy.weekend_allowed),
        "weekendDays": list(policy.weekend_days or []),
        "holidayCalendarKey": policy.holiday_calendar_key,
        "effectiveFrom": policy.effective_from.isoformat(),
        "createdBy": policy.created_by,
        "createdAt": policy.created_at.isoformat() if policy.created_at else None,
        "updatedAt": policy.updated_at.isoformat() if policy.updated_at else None,
        "isActive": bool(policy.is_active),
    }


def assignment_to_dict(row: PolicyAssignment) -> dict[str, Any]:
    return {
        "id": row.id,
        "policyId": row.policy_id,
        "scopeType": row.scope_type,
        "scopeValue": row.scope_value,
        "effectiveFrom": row.effective_from.isoformat(),
        "createdBy": row.created_by,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
    }


def resolve_policy_for_employee(
    session: Session,
    *,
    employee_id: str,
    department: str,
    role: str,
    on_date: date,
) -> ResolvedPolicy | None:
    candidates = [
        ("employee", employee_id),
        ("role", role or ""),
        ("department", department or ""),
        ("company", "*"),
    ]

    matched: list[tuple[int, PolicyAssignment, AttendancePolicy]] = []
    for scope_type, scope_value in candidates:
        if scope_type != "company" and not scope_value:
            continue

        query = (
            select(PolicyAssignment, AttendancePolicy)
            .join(AttendancePolicy, AttendancePolicy.id == PolicyAssignment.policy_id)
            .where(
                and_(
                    PolicyAssignment.scope_type == scope_type,
                    PolicyAssignment.scope_value == scope_value,
                    PolicyAssignment.effective_from <= on_date,
                    AttendancePolicy.is_active.is_(True),
                )
            )
            .order_by(desc(PolicyAssignment.effective_from), desc(PolicyAssignment.created_at))
            .limit(1)
        )
        row = session.execute(query).first()
        if row:
            assignment, policy = row
            matched.append((_SCOPE_PRIORITY.get(scope_type, 0), assignment, policy))

    if not matched:
        fallback = session.execute(
            select(AttendancePolicy)
            .where(and_(AttendancePolicy.is_active.is_(True), AttendancePolicy.effective_from <= on_date))
            .order_by(desc(AttendancePolicy.effective_from), desc(AttendancePolicy.created_at))
            .limit(1)
        ).scalar_one_or_none()
        if not fallback:
            return None
        return ResolvedPolicy(policy=fallback, resolved_by="fallback", resolved_value="")

    matched.sort(key=lambda item: (item[0], item[1].effective_from, item[1].created_at), reverse=True)
    _, assignment, policy = matched[0]
    return ResolvedPolicy(policy=policy, resolved_by=assignment.scope_type, resolved_value=assignment.scope_value)


def calculate_attendance(policy: AttendancePolicy | dict[str, Any], check_in: datetime | str, check_out: datetime | str | None) -> dict[str, Any]:
    """Core attendance rule engine.

    Rules:
    - status by working hours thresholds
    - isLate by shiftStart + lateGraceMinutes
    - absent override if checkIn > absentCutoffHour
    - overtimeHours when work exceeds fullDayHours
    """
    if isinstance(policy, AttendancePolicy):
        shift_start = policy.shift_start
        late_grace = int(policy.late_grace_minutes)
        half_day = float(policy.half_day_hours)
        full_day = float(policy.full_day_hours)
        absent_cutoff_hour = int(policy.absent_cutoff_hour)
    else:
        shift_start = str(policy.get("shiftStart") or "09:00")
        late_grace = int(policy.get("lateGraceMinutes") or 15)
        half_day = float(policy.get("halfDayHours") or 4.0)
        full_day = float(policy.get("fullDayHours") or 8.0)
        absent_cutoff_hour = int(policy.get("absentCutoffHour") or 10)

    if isinstance(check_in, str):
        check_in_dt = datetime.fromisoformat(check_in.replace("Z", "+00:00"))
    else:
        check_in_dt = check_in

    if isinstance(check_out, str):
        check_out_dt = datetime.fromisoformat(check_out.replace("Z", "+00:00"))
    else:
        check_out_dt = check_out

    if check_in_dt.tzinfo is not None:
        check_in_dt = check_in_dt.replace(tzinfo=None)
    if check_out_dt is not None and check_out_dt.tzinfo is not None:
        check_out_dt = check_out_dt.replace(tzinfo=None)

    working_hours = _safe_hours(check_in_dt, check_out_dt)

    if working_hours >= full_day:
        status = "present"
    elif working_hours >= half_day:
        status = "half_day"
    else:
        status = "absent"

    shift_start_dt = _combine_with_checkin_date(check_in_dt, shift_start)
    late_threshold_dt = shift_start_dt + timedelta(minutes=max(0, late_grace))
    is_late = check_in_dt > late_threshold_dt

    absent_cutoff_dt = datetime.combine(check_in_dt.date(), time(hour=max(0, min(23, absent_cutoff_hour)), minute=0))
    if check_in_dt > absent_cutoff_dt:
        status = "absent"

    overtime_hours = round(max(0.0, working_hours - full_day), 2)

    return {
        "status": status,
        "isLate": bool(is_late),
        "workingHours": round(float(working_hours), 2),
        "overtimeHours": overtime_hours,
    }
