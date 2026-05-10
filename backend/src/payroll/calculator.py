"""
Payroll Calculation Engine
==========================
Employee-policy-aware salary computation with:
  - Saturday policy support (OFF / WORKING / HALF_DAY)
  - Daily salary accrual
  - Attendance-status-based earning/deduction
  - Overtime calculation
  - Half-day logic
  - Paid holidays
  - Leave exhaustion handling
"""
from __future__ import annotations

import calendar
import logging
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("attendance.payroll")

# ─── Constants ───────────────────────────────────────────────────────────────

SATURDAY = 5  # weekday() index
SUNDAY = 6

ATTENDANCE_STATUS_PRESENT = "present"
ATTENDANCE_STATUS_HALF_DAY = "half_day"
ATTENDANCE_STATUS_ABSENT = "absent"
ATTENDANCE_STATUS_LEAVE = "leave"
ATTENDANCE_STATUS_HOLIDAY = "holiday"
ATTENDANCE_STATUS_WEEKEND = "weekend"
ATTENDANCE_STATUS_LATE = "late"
ATTENDANCE_STATUS_EARLY_OUT = "early_out"

SATURDAY_POLICY_OFF = "OFF"
SATURDAY_POLICY_WORKING = "WORKING"
SATURDAY_POLICY_HALF_DAY = "HALF_DAY"

PAYROLL_STATUS_DRAFT = "draft"
PAYROLL_STATUS_PROCESSING = "processing"
PAYROLL_STATUS_PAID = "paid"
PAYROLL_STATUS_FAILED = "failed"

# ─── Helpers ─────────────────────────────────────────────────────────────────


def _today_ist() -> date:
    """Return today's date in IST (UTC+5:30)."""
    ist_offset = timedelta(hours=5, minutes=30)
    return (datetime.utcnow() + ist_offset).date()


def _parse_time(t: Any) -> Optional[Tuple[int, int]]:
    """Parse 'HH:MM' into (hour, minute), returns None on failure."""
    try:
        parts = str(t or "").strip().split(":")
        return int(parts[0]), int(parts[1])
    except Exception:
        return None


def _date_key(value: Any) -> str:
    """Normalize date-like DB values to YYYY-MM-DD strings."""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value or "").strip()
    return text[:10] if len(text) >= 10 else text


def _leave_type_bucket(value: Any) -> str:
    """Map leave_request.leave_type to payroll buckets."""
    text = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if text in {"sl", "sick", "sick_leave", "medical", "medical_leave"}:
        return "sick"
    if text in {"cl", "casual", "casual_leave"}:
        return "casual"
    if text in {"lop", "lwp", "unpaid", "unpaid_leave", "leave_without_pay"}:
        return "unpaid"
    return "paid"


def _is_attendance_present_like(row: Optional[dict]) -> bool:
    if not row:
        return False
    status = str(
        row.get("status")
        or row.get("attendance_status")
        or row.get("entry_status")
        or ""
    ).strip().lower()
    timing = str(row.get("timing_status") or "").strip().lower()
    if status in {"absent", "leave", "paid_leave", "unpaid_leave", "lwp", "half_day"}:
        return False
    return status in {
        "present", "late", "early_out", "p", "checked_in", "checked_out",
        "on time", "on time exit", "left early",
    } or timing in {"late", "left early", "on time", "on time exit"}


def get_working_days_in_month(
    year: int,
    month: int,
    saturday_policy: str = SATURDAY_POLICY_OFF,
    paid_holidays: Optional[List[str]] = None,
) -> int:
    """
    Return the count of working days in a month based on Saturday policy.
    - Sundays are always off.
    - SATURDAY_POLICY_OFF → Saturdays are paid weekends (still count as payable, not as working).
    - SATURDAY_POLICY_WORKING → Saturdays count as working days.
    - SATURDAY_POLICY_HALF_DAY → Saturdays count as 0.5 days.
    """
    total = 0.0
    paid_holiday_set = set(paid_holidays or [])
    _, days_in_month = calendar.monthrange(year, month)
    for day in range(1, days_in_month + 1):
        d = date(year, month, day)
        if d.isoformat() in paid_holiday_set:
            continue
        wd = d.weekday()
        if wd == SUNDAY:
            continue
        if wd == SATURDAY:
            if saturday_policy == SATURDAY_POLICY_WORKING:
                total += 1.0
            elif saturday_policy == SATURDAY_POLICY_HALF_DAY:
                total += 0.5
            # OFF → skip (Saturdays are paid but not working days for basis)
        else:
            total += 1.0
    return max(1, round(total))


def get_calendar_attendance_counts(
    year: int,
    month: int,
    saturday_policy: str = SATURDAY_POLICY_OFF,
    paid_holidays: Optional[List[str]] = None,
    through_day: Optional[int] = None,
) -> dict:
    """Return non-overlapping calendar counts used by payroll proration."""
    _, month_days = calendar.monthrange(year, month)
    total_days = min(through_day or month_days, month_days)
    paid_holiday_set = set(paid_holidays or [])
    saturday_policy = str(saturday_policy or SATURDAY_POLICY_OFF).upper()

    sundays = 0
    saturday_offs = 0
    holiday_days = 0
    for day in range(1, total_days + 1):
        d = date(year, month, day)
        wd = d.weekday()
        if wd == SUNDAY:
            sundays += 1
            continue
        if wd == SATURDAY and saturday_policy == SATURDAY_POLICY_OFF:
            saturday_offs += 1
            continue
        if d.isoformat() in paid_holiday_set:
            holiday_days += 1

    working_days = max(1, total_days - sundays - saturday_offs - holiday_days)
    return {
        "totalDaysInMonth": total_days,
        "sundaysInMonth": sundays,
        "saturdaysOffInMonth": saturday_offs,
        "holidayDays": holiday_days,
        "workingDaysInMonth": working_days,
    }


def _get_daily_rate(monthly_salary: float, calendar_days_in_month: int) -> float:
    """Per-day salary rate: monthly gross ÷ actual calendar days in month (never working-day divisor)."""
    if calendar_days_in_month <= 0:
        return 0.0
    return round(monthly_salary / calendar_days_in_month, 4)


def _overtime_rate_per_hour(daily_rate: float, shift_hours: float = 9.0) -> float:
    """Overtime rate = 1.5× the hourly rate."""
    if shift_hours <= 0:
        return 0.0
    hourly = daily_rate / shift_hours
    return round(hourly * 1.5, 4)


# ─── Default work policy ─────────────────────────────────────────────────────

DEFAULT_WORK_POLICY: Dict[str, Any] = {
    "saturdayPolicy": SATURDAY_POLICY_OFF,
    "shiftStart": "09:00",
    "shiftEnd": "18:00",
    "graceMinutes": 15,
    "overtimeEligible": True,
    "paidLeavesPerMonth": 2,
    "lateDeductionEnabled": False,
    "lateDeductionPerMinute": 0.0,
}


def _resolve_policy(employee: dict) -> dict:
    base = dict(DEFAULT_WORK_POLICY)
    stored = employee.get("work_policy") or {}
    if isinstance(stored, dict):
        base.update(stored)
    return base


# ─── Day classification ───────────────────────────────────────────────────────


def _classify_day(
    d: date,
    policy: dict,
    attendance_row: Optional[dict],
    paid_holidays: Optional[List[str]] = None,
) -> dict:
    """
    Return a classification dict:
      status, earned_factor (0-1), is_overtime_possible, note
    """
    paid_holidays = paid_holidays or []
    wd = d.weekday()
    date_str = d.isoformat()
    saturday_policy = str(policy.get("saturdayPolicy") or SATURDAY_POLICY_OFF).upper()

    # ── Sunday ───────────────────────────────────────────────────────────────
    # Calendar payroll: gross ÷ calendar days in month; weekly offs earn that day-rate.
    if wd == SUNDAY:
        return {
            "status": ATTENDANCE_STATUS_WEEKEND,
            "earned_factor": 1.0,
            "is_overtime_possible": False,
            "note": "Sunday – weekly off (paid)",
        }

    # ── Saturday ─────────────────────────────────────────────────────────────
    if wd == SATURDAY:
        if saturday_policy == SATURDAY_POLICY_OFF:
            return {
                "status": ATTENDANCE_STATUS_WEEKEND,
                "earned_factor": 1.0,
                "is_overtime_possible": False,
                "note": "Saturday OFF – weekly off (paid)",
            }
        if saturday_policy == SATURDAY_POLICY_HALF_DAY:
            if not attendance_row:
                return {
                    "status": ATTENDANCE_STATUS_HALF_DAY,
                    "earned_factor": 0.5,
                    "is_overtime_possible": False,
                    "note": "Saturday half-day",
                }
            raw_status = str(attendance_row.get("status") or "").strip().lower()
            if raw_status in ("absent",):
                return {
                    "status": ATTENDANCE_STATUS_ABSENT,
                    "earned_factor": 0.0,
                    "is_overtime_possible": False,
                    "note": "Saturday absent",
                }
            return {
                "status": ATTENDANCE_STATUS_HALF_DAY,
                "earned_factor": 0.5,
                "is_overtime_possible": False,
                "note": "Saturday half-day",
            }
        # WORKING Saturday – fall through to normal day logic

    # ── Holiday check ────────────────────────────────────────────────────────
    # Holidays overlapping weekly offs are not double-counted for working days.
    if date_str in paid_holidays:
        return {
            "status": ATTENDANCE_STATUS_HOLIDAY,
            "earned_factor": 1.0,
            "is_overtime_possible": False,
            "note": "Paid holiday",
        }

    # ── No attendance row ────────────────────────────────────────────────────
    if not attendance_row:
        return {
            "status": ATTENDANCE_STATUS_ABSENT,
            "earned_factor": 0.0,
            "is_overtime_possible": False,
            "note": "No attendance recorded",
        }

    raw_status = str(attendance_row.get("status") or "").strip().lower()

    # ── Leave ────────────────────────────────────────────────────────────────
    if raw_status in ("leave", "paid_leave"):
        return {
            "status": ATTENDANCE_STATUS_LEAVE,
            "earned_factor": 1.0,
            "is_overtime_possible": False,
            "note": "Paid leave",
        }
    if raw_status in ("unpaid_leave", "lwp"):
        return {
            "status": ATTENDANCE_STATUS_LEAVE,
            "earned_factor": 0.0,
            "is_overtime_possible": False,
            "note": "Leave without pay",
        }

    # ── Absent ───────────────────────────────────────────────────────────────
    if raw_status == "absent":
        return {
            "status": ATTENDANCE_STATUS_ABSENT,
            "earned_factor": 0.0,
            "is_overtime_possible": False,
            "note": "Absent",
        }

    # ── Half day ─────────────────────────────────────────────────────────────
    if "half" in raw_status or raw_status == "half_day":
        return {
            "status": ATTENDANCE_STATUS_HALF_DAY,
            "earned_factor": 0.5,
            "is_overtime_possible": False,
            "note": "Half day",
        }

    # ── Present / Late / Early out ───────────────────────────────────────────
    # Real DB values from AttendanceManager: "checked_out", "checked_in"
    # Legacy/manual values: "present", "late", "early_out", "p"
    # Timing detail stored in timing_status field: "Late", "Left Early", "On Time Exit"
    PRESENT_LIKE = (
        "present", "late", "early_out", "p",
        "checked_in", "checked_out",
        "on time", "on time exit", "left early",
    )
    if raw_status in PRESENT_LIKE:
        overtime_eligible = bool(policy.get("overtimeEligible", True))
        # Refine to late/early_out using timing_status when available
        timing = str(attendance_row.get("timing_status") or "").strip().lower()
        if raw_status == "late" or timing == "late":
            final_status = ATTENDANCE_STATUS_LATE
        elif raw_status == "early_out" or timing == "left early":
            final_status = ATTENDANCE_STATUS_EARLY_OUT
        else:
            final_status = ATTENDANCE_STATUS_PRESENT
        return {
            "status": final_status,
            "earned_factor": 1.0,
            "is_overtime_possible": overtime_eligible,
            "note": f"Present ({timing or raw_status})",
        }

    # Fallback for unknown statuses — treat as absent, log for debugging
    logger.debug("payroll_classify_unknown_status: %s for date %s", raw_status, date_str)
    return {
        "status": ATTENDANCE_STATUS_ABSENT,
        "earned_factor": 0.0,
        "is_overtime_possible": False,
        "note": f"Unknown status: {raw_status}",
    }


def _calc_overtime_hours(attendance_row: dict, policy: dict) -> float:
    """Return overtime hours for a day based on actual work hours vs shift length."""
    if not attendance_row:
        return 0.0

    explicit = (
        attendance_row.get("overtime_hours")
        or attendance_row.get("overtimeHours")
        or attendance_row.get("ot_hours")
    )
    try:
        explicit_hours = float(explicit or 0.0)
        if explicit_hours > 0:
            return round(explicit_hours, 2)
    except (TypeError, ValueError):
        pass

    shift_end = _parse_time(policy.get("shiftEnd", "18:00"))
    if shift_end is None:
        return 0.0

    work_hours = (
        attendance_row.get("work_hours")
        or attendance_row.get("working_hours")
        or attendance_row.get("total_hours")
        or attendance_row.get("workingHours")
        or 0.0
    )
    try:
        work_hours = float(work_hours)
    except (TypeError, ValueError):
        return 0.0

    shift_start = _parse_time(policy.get("shiftStart", "09:00"))
    if shift_start is None:
        return 0.0

    shift_duration = (
        (shift_end[0] * 60 + shift_end[1]) - (shift_start[0] * 60 + shift_start[1])
    ) / 60.0

    overtime = max(0.0, work_hours - shift_duration)
    return round(overtime, 2)


# ─── Core daily calculator ────────────────────────────────────────────────────


def calculate_day(
    d: date,
    employee: dict,
    attendance_row: Optional[dict],
    paid_holidays: Optional[List[str]] = None,
) -> dict:
    """
    Calculate the salary ledger entry for a single day.

    Per-day rate uses full calendar length of the salary month (gross ÷ days in month).
    Full LOP/absence does not write a deduction row (avoid double-count vs summary LOP line).

    Returns:
        {
          date, attendanceStatus, earnedAmount, deductionAmount,
          overtimeHours, overtimeAmount, finalAmount, calculationMeta
        }
    """
    monthly_salary = float(
        employee.get("monthly_salary")
        or employee.get("net_target_monthly")
        or 0.0,
    )
    policy = _resolve_policy(employee)

    year, month = d.year, d.month
    _, calendar_len = calendar.monthrange(year, month)
    calendar_days_denominator = int(calendar_len)
    daily_rate = _get_daily_rate(monthly_salary, calendar_days_denominator)

    classification = _classify_day(d, policy, attendance_row, paid_holidays)
    earned_factor = classification["earned_factor"]
    status = classification["status"]

    earned = round(daily_rate * earned_factor, 2)
    # Partial days (e.g. half-day): withhold the unpaid fraction. Full absence/unpaid leave
    # use earned_factor 0 — LOP rupee impact is surfaced only via summary absentDeduction.
    if earned_factor <= 0.0:
        deduction = 0.0
    elif earned_factor >= 1.0:
        deduction = 0.0
    else:
        deduction = round(daily_rate * (1.0 - earned_factor), 2)

    # Late deduction
    late_deduction = 0.0
    if (
        status == ATTENDANCE_STATUS_LATE
        and policy.get("lateDeductionEnabled")
        and attendance_row
    ):
        late_by = int(attendance_row.get("late_by_minutes") or 0)
        per_min = float(policy.get("lateDeductionPerMinute") or 0.0)
        late_deduction = round(late_by * per_min, 2)
        deduction = round(deduction + late_deduction, 2)
        earned = max(0.0, round(earned - late_deduction, 2))

    # Overtime
    overtime_hours = 0.0
    overtime_amount = 0.0
    if classification["is_overtime_possible"] and attendance_row:
        shift_start_t = _parse_time(policy.get("shiftStart", "09:00"))
        shift_end_t = _parse_time(policy.get("shiftEnd", "18:00"))
        shift_hours = 9.0
        if shift_start_t and shift_end_t:
            shift_hours = ((shift_end_t[0] * 60 + shift_end_t[1]) - (shift_start_t[0] * 60 + shift_start_t[1])) / 60.0
        overtime_hours = _calc_overtime_hours(attendance_row, policy)
        ot_rate = _overtime_rate_per_hour(daily_rate, shift_hours)
        overtime_amount = round(overtime_hours * ot_rate, 2)

    final_amount = round(earned + overtime_amount, 2)

    return {
        "date": d.isoformat(),
        "attendanceStatus": status,
        "earnedAmount": earned,
        "deductionAmount": deduction,
        "overtimeHours": overtime_hours,
        "overtimeAmount": overtime_amount,
        "finalAmount": final_amount,
        "calculationMeta": {
            "monthlySalary": monthly_salary,
            "calendarDaysInMonth": calendar_days_denominator,
            "dailyRate": daily_rate,
            "earnedFactor": earned_factor,
            "saturdayPolicy": str(policy.get("saturdayPolicy") or SATURDAY_POLICY_OFF).upper(),
            "note": classification["note"],
        },
    }


# ─── Monthly calculator ───────────────────────────────────────────────────────


class PayrollCalculator:
    """High-level payroll engine that works against a MongoDB database."""

    def __init__(self, db):
        self.db = db

    def _employee_id_query(self, employee_id_str: str) -> Any:
        try:
            from bson import ObjectId as _ObjId
            from bson.errors import InvalidId as _InvalidId

            try:
                oid = _ObjId(employee_id_str)
                return {"$in": [oid, employee_id_str]}
            except _InvalidId:
                return employee_id_str
        except Exception:
            return employee_id_str

    def _get_paid_holidays(self, year: int, month: int) -> List[str]:
        """Return ISO date strings of paid holidays in the given month."""
        try:
            start = date(year, month, 1).isoformat()
            _, last_day = calendar.monthrange(year, month)
            end = date(year, month, last_day).isoformat()
            docs = list(
                self.db.holidays.find(
                    {"date": {"$gte": start, "$lte": end}, "paid": {"$ne": False}}
                )
            )
            return [_date_key(d.get("date")) for d in docs if d.get("date")]
        except Exception:
            return []

    def _collect_month_source_data(
        self,
        employee: dict,
        year: int,
        month: int,
        end_day: int,
    ) -> dict:
        """
        Read the authoritative payroll attendance sources:
          - attendance_logs collection (new canonical table)
          - attendance collection (legacy/live attendance rows)
          - leave_requests collection (approved leave)
          - holidays collection (paid holidays)
        """
        employee_id_raw = employee.get("_id") or employee.get("id") or ""
        employee_id_str = str(employee_id_raw)
        employee_name = str(employee.get("name") or "")
        id_query = self._employee_id_query(employee_id_str)

        start_str = date(year, month, 1).isoformat()
        end_str = date(year, month, end_day).isoformat()
        date_filter = {"$gte": start_str, "$lte": end_str}

        attendance_rows: List[dict] = []
        attendance_collections = []
        for collection_name in ("attendance_logs", "attendance"):
            try:
                collection = self.db[collection_name]
                rows = list(collection.find({"employee_id": id_query, "date": date_filter}))
                if not rows and employee_name:
                    rows = list(collection.find({"employee_name": employee_name, "date": date_filter}))
                if rows:
                    attendance_collections.append(collection_name)
                    for row in rows:
                        row["_source_collection"] = collection_name
                    attendance_rows.extend(rows)
            except Exception:
                logger.debug("payroll_attendance_source_failed: %s", collection_name, exc_info=True)

        def _row_sort_key(row: dict) -> str:
            return str(row.get("updated_at") or row.get("updatedAt") or row.get("created_at") or row.get("createdAt") or "")

        attendance_rows.sort(key=_row_sort_key)
        att_map: Dict[str, dict] = {}
        for row in attendance_rows:
            d_key = _date_key(row.get("date"))
            if d_key:
                att_map[d_key] = row

        leave_rows: List[dict] = []
        try:
            leave_rows = list(
                self.db.leave_requests.find(
                    {
                        "employee_id": id_query,
                        "status": "approved",
                        "start_date": {"$lte": end_str},
                        "end_date": {"$gte": start_str},
                    }
                )
            )
            if not leave_rows and employee_name:
                leave_rows = list(
                    self.db.leave_requests.find(
                        {
                            "employee_name": employee_name,
                            "status": "approved",
                            "start_date": {"$lte": end_str},
                            "end_date": {"$gte": start_str},
                        }
                    )
                )
        except Exception:
            logger.debug("payroll_leave_source_failed", exc_info=True)

        leave_map: Dict[str, dict] = {}
        for leave in leave_rows:
            try:
                start = max(datetime.strptime(_date_key(leave.get("start_date")), "%Y-%m-%d").date(), date(year, month, 1))
                end = min(datetime.strptime(_date_key(leave.get("end_date")), "%Y-%m-%d").date(), date(year, month, end_day))
            except Exception:
                continue
            bucket = _leave_type_bucket(leave.get("leave_type"))
            cursor = start
            while cursor <= end:
                d_key = cursor.isoformat()
                existing = leave_map.get(d_key)
                # Unpaid leave must win if overlapping requests somehow exist.
                if not existing or bucket == "unpaid":
                    leave_map[d_key] = {
                        "leaveType": str(leave.get("leave_type") or "paid").strip().lower(),
                        "leaveBucket": bucket,
                        "requestId": str(leave.get("_id") or ""),
                    }
                cursor += timedelta(days=1)

        paid_holidays = self._get_paid_holidays(year, month)

        return {
            "attendanceRows": attendance_rows,
            "attendanceMap": att_map,
            "leaveRows": leave_rows,
            "leaveMap": leave_map,
            "paidHolidays": paid_holidays,
            "attendanceCollections": attendance_collections,
            "attendanceRecordCount": len(attendance_rows),
            "approvedLeaveRecordCount": len(leave_rows),
            "holidayRecordCount": len(paid_holidays),
            "lastSyncedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }

    def calculate_employee_month(
        self,
        employee: dict,
        year: int,
        month: int,
        up_to_day: Optional[int] = None,
    ) -> List[dict]:
        """
        Calculate daily salary ledger entries for an employee for a full month
        (or up to `up_to_day`).
        """
        _, last_day = calendar.monthrange(year, month)
        end_day = min(up_to_day or last_day, last_day)

        employee_id_raw = employee.get("_id") or employee.get("id") or ""
        employee_id_str = str(employee_id_raw)
        source = self._collect_month_source_data(employee, year, month, end_day)
        paid_holidays = source["paidHolidays"]
        att_map = source["attendanceMap"]
        leave_map = source["leaveMap"]

        policy = _resolve_policy(employee)
        sat_pol = str(policy.get("saturdayPolicy") or SATURDAY_POLICY_OFF).upper()
        calendar_counts = get_calendar_attendance_counts(
            year, month, sat_pol, paid_holidays, end_day
        )

        entries = []
        for day in range(1, end_day + 1):
            d = date(year, month, day)
            att_row = att_map.get(d.isoformat())
            leave_info = leave_map.get(d.isoformat())
            if leave_info and not _is_attendance_present_like(att_row):
                att_row = dict(att_row or {})
                att_row["status"] = "unpaid_leave" if leave_info["leaveBucket"] == "unpaid" else "paid_leave"
                att_row["leave_type"] = leave_info["leaveType"]
            entry = calculate_day(d, employee, att_row, paid_holidays)
            if leave_info:
                entry["calculationMeta"]["leaveType"] = leave_info["leaveType"]
                entry["calculationMeta"]["leaveBucket"] = leave_info["leaveBucket"]
            entry["employeeId"] = employee_id_str
            entries.append(entry)

        return entries

    def get_month_summary(
        self,
        employee: dict,
        year: int,
        month: int,
        up_to_day: Optional[int] = None,
    ) -> dict:
        """Return aggregated payroll summary for an employee for a month."""
        employee_id_str = str(employee.get("_id") or employee.get("id") or "")
        employee_name   = str(employee.get("name") or "")
        _, last_day = calendar.monthrange(year, month)
        end_day = min(up_to_day or last_day, last_day)
        source = self._collect_month_source_data(employee, year, month, end_day)
        entries = self.calculate_employee_month(employee, year, month, up_to_day)

        total_overtime = sum(e["overtimeAmount"] for e in entries)
        total_ot_hours = sum(e["overtimeHours"] for e in entries)

        status_counts: Dict[str, int] = {}
        for e in entries:
            s = e["attendanceStatus"]
            status_counts[s] = status_counts.get(s, 0) + 1

        present_days = (
            status_counts.get(ATTENDANCE_STATUS_PRESENT, 0)
            + status_counts.get(ATTENDANCE_STATUS_LATE, 0)
            + status_counts.get(ATTENDANCE_STATUS_EARLY_OUT, 0)
        )

        monthly_salary = float(
            employee.get("monthly_salary") or employee.get("net_target_monthly") or 0.0,
        )
        policy = _resolve_policy(employee)
        sat_pol = str(policy.get("saturdayPolicy") or SATURDAY_POLICY_OFF).upper()
        calendar_counts = get_calendar_attendance_counts(year, month, sat_pol, source["paidHolidays"], end_day)
        working_days_elapsed_slot = calendar_counts["workingDaysInMonth"]
        _, full_cal_len = calendar.monthrange(year, month)
        full_calendar_days = int(full_cal_len)
        elapsed_calendar_days = calendar_counts["totalDaysInMonth"]

        absent_days    = status_counts.get(ATTENDANCE_STATUS_ABSENT, 0)
        half_days      = status_counts.get(ATTENDANCE_STATUS_HALF_DAY, 0)
        weekoff_days   = status_counts.get(ATTENDANCE_STATUS_WEEKEND, 0)
        holiday_days   = status_counts.get(ATTENDANCE_STATUS_HOLIDAY, 0)
        late_marks     = status_counts.get(ATTENDANCE_STATUS_LATE, 0)
        early_exits    = status_counts.get(ATTENDANCE_STATUS_EARLY_OUT, 0)

        casual_leave_days = 0
        sick_leave_days = 0
        other_paid_leave_days = 0
        unpaid_leave_days = 0
        for e in entries:
            if e["attendanceStatus"] != ATTENDANCE_STATUS_LEAVE:
                continue
            meta = e.get("calculationMeta") or {}
            bucket = str(meta.get("leaveBucket") or _leave_type_bucket(meta.get("leaveType"))).lower()
            earned_factor = float(meta.get("earnedFactor") or 0.0)
            if bucket == "unpaid" or earned_factor <= 0:
                unpaid_leave_days += 1
            elif bucket == "casual":
                casual_leave_days += 1
            elif bucket == "sick":
                sick_leave_days += 1
            else:
                other_paid_leave_days += 1
        paid_leave_days = casual_leave_days + sick_leave_days + other_paid_leave_days

        # Calendar-based rate; LOP ₹ = rate × LOP-day-units (not subtracted again from earnedTillNow).
        daily_rate_val = monthly_salary / max(1, full_calendar_days)
        lop_day_units = float(absent_days + unpaid_leave_days) + half_days * 0.5
        absent_deduction = round((float(absent_days) + float(unpaid_leave_days)) * daily_rate_val, 2)
        half_day_deduction = round(half_days * daily_rate_val * 0.5, 2)

        # Payable till date (matches user-facing definition): Present + paid leave + holidays + weekends + half paid.
        paid_days = round(
            present_days + paid_leave_days + holiday_days + weekoff_days + (half_days * 0.5),
            1,
        )
        lop_days = round(max(0.0, lop_day_units), 1)

        late_entry_deduction = sum(
            float(e.get("deductionAmount") or 0.0)
            for e in entries
            if e.get("attendanceStatus") == ATTENDANCE_STATUS_LATE
        )
        late_penalty = 0.0
        if bool(policy.get("lateDeductionEnabled") or policy.get("latePenaltyEnabled")):
            allowed_late_marks = int(policy.get("lateMarksAllowed") or policy.get("latePenaltyAfter") or 0)
            penalized_marks = max(0, late_marks - allowed_late_marks)
            per_mark = float(policy.get("latePenaltyPerMark") or policy.get("lateDeductionPerLateMark") or 0.0)
            late_penalty = round(max(late_entry_deduction, penalized_marks * per_mark), 2)

        resolved_day_units = float(paid_days) + float(lop_day_units)
        attendance_pct = (
            round((float(paid_days) / resolved_day_units) * 100, 1)
            if resolved_day_units > 0 else 0.0
        )
        total_earned_attendance = round(sum(float(e["earnedAmount"]) for e in entries), 2)
        earned_till = max(0.0, round(total_earned_attendance - late_penalty, 2))
        final_payable = round(max(0.0, earned_till + total_overtime), 2)

        return {
            "employeeId": employee_id_str,
            "employeeName": employee_name,
            "year": year,
            "month": month,
            "monthlySalary": monthly_salary,
            "calendarDaysInFullMonth": full_calendar_days,
            "elapsedCalendarDays": elapsed_calendar_days,
            "totalDaysInMonth": elapsed_calendar_days,
            "sundaysInMonth": calendar_counts["sundaysInMonth"],
            "saturdaysInMonth": calendar_counts["saturdaysOffInMonth"],
            "saturdaysOffInMonth": calendar_counts["saturdaysOffInMonth"],
            "workingDaysInMonth": working_days_elapsed_slot,
            "daysTracked": len(entries),
            "presentDays": present_days,
            "absentDays": absent_days,
            "halfDays": half_days,
            "casualLeaveDays": casual_leave_days,
            "sickLeaveDays": sick_leave_days,
            "paidLeaveDays": paid_leave_days,
            "unpaidLeaveDays": unpaid_leave_days,
            "weekoffDays": weekoff_days,
            "holidayDays": holiday_days,
            "paidHolidayDays": holiday_days,
            "paidDays": round(paid_days, 1),
            "lopDays": lop_days,
            "absentDeduction": absent_deduction,
            "halfDayDeduction": half_day_deduction,
            "latePenalty": late_penalty,
            "lateMarks": late_marks,
            "earlyExits": early_exits,
            "attendancePercentage": attendance_pct,
            "earnedTillNow": earned_till,
            "totalDeductions": round(absent_deduction + half_day_deduction + late_penalty, 2),
            "totalOvertime": round(total_overtime, 2),
            "totalOvertimeHours": round(total_ot_hours, 2),
            "finalPayable": final_payable,
            "statusBreakdown": status_counts,
            "attendanceSource": "database",
            "attendanceSourceCollections": source["attendanceCollections"],
            "attendanceRecordCount": source["attendanceRecordCount"],
            "approvedLeaveRecordCount": source["approvedLeaveRecordCount"],
            "holidayRecordCount": source["holidayRecordCount"],
            "lastSyncedAt": source["lastSyncedAt"],
            "sourceMessage": (
                f"Attendance synced from {source['attendanceRecordCount']} attendance records "
                f"and {source['approvedLeaveRecordCount']} approved leave records."
            ),
            "dailyEntries": entries,
        }

    def upsert_salary_ledger(
        self,
        employee: dict,
        year: int,
        month: int,
        up_to_day: Optional[int] = None,
    ) -> int:
        """Write/update daily salary ledger entries in MongoDB. Returns count written."""
        entries = self.calculate_employee_month(employee, year, month, up_to_day)
        count = 0
        for entry in entries:
            self.db.salary_ledger.update_one(
                {
                    "employeeId": entry["employeeId"],
                    "date": entry["date"],
                },
                {"$set": entry},
                upsert=True,
            )
            count += 1
        return count

    def run_daily_update(self) -> dict:
        """
        Cron entry point: called once per day.
        Processes all active employees and updates today's salary ledger.
        """
        today = _today_ist()
        year, month, day = today.year, today.month, today.day
        logger.info("payroll_daily_update_start: %s", today.isoformat())

        employees = list(self.db.employees.find({"status": "active"}))
        success, errors = 0, 0
        for emp in employees:
            try:
                self.upsert_salary_ledger(emp, year, month, up_to_day=day)
                success += 1
            except Exception as exc:
                logger.exception(
                    "payroll_daily_update_error for employee %s: %s",
                    str(emp.get("_id", "")),
                    exc,
                )
                errors += 1

        logger.info(
            "payroll_daily_update_done: success=%s errors=%s", success, errors
        )
        return {"success": success, "errors": errors, "date": today.isoformat()}

    def run_monthly_finalizer(self, year: int, month: int) -> dict:
        """
        Month-end cron: lock payroll, generate summaries, store payroll_summary docs.
        """
        logger.info("payroll_monthly_finalizer_start: %s-%02d", year, month)
        _, last_day = calendar.monthrange(year, month)

        employees = list(self.db.employees.find({"status": "active"}))
        summaries = []
        for emp in employees:
            try:
                summary = self.get_month_summary(emp, year, month, up_to_day=last_day)
                summary["payrollStatus"] = PAYROLL_STATUS_DRAFT
                summary["finalizedAt"] = datetime.utcnow().isoformat()
                self.db.payroll_summary.update_one(
                    {"employeeId": summary["employeeId"], "year": year, "month": month},
                    {"$set": summary},
                    upsert=True,
                )
                summaries.append(summary)
            except Exception as exc:
                logger.exception(
                    "payroll_finalizer_error for employee %s: %s",
                    str(emp.get("_id", "")),
                    exc,
                )

        logger.info(
            "payroll_monthly_finalizer_done: %s summaries generated", len(summaries)
        )
        return {"summaries": len(summaries), "year": year, "month": month}


# ─── Scheduler ────────────────────────────────────────────────────────────────


def start_payroll_scheduler(db, interval_seconds: int = 3600) -> threading.Thread:
    """
    Start a background thread that:
      - Runs daily payroll update every `interval_seconds` (default: hourly check).
      - Runs monthly finalizer on the last day of each month.

    The actual daily update is rate-limited to once per calendar day.
    """
    calculator = PayrollCalculator(db)
    last_run_date: dict = {"daily": None, "monthly": None}

    def _worker():
        while True:
            try:
                today = _today_ist()
                date_str = today.isoformat()

                # Daily update – once per day
                if last_run_date["daily"] != date_str:
                    calculator.run_daily_update()
                    last_run_date["daily"] = date_str

                # Monthly finalizer – on last day of month
                _, last_day = calendar.monthrange(today.year, today.month)
                month_key = f"{today.year}-{today.month:02d}"
                if today.day == last_day and last_run_date["monthly"] != month_key:
                    calculator.run_monthly_finalizer(today.year, today.month)
                    last_run_date["monthly"] = month_key

            except Exception as exc:
                logger.exception("payroll_scheduler_error: %s", exc)

            time.sleep(interval_seconds)

    t = threading.Thread(target=_worker, daemon=True, name="payroll-scheduler")
    t.start()
    logger.info("payroll_scheduler_started: interval=%ss", interval_seconds)
    return t
