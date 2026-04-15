from datetime import datetime, timedelta, timezone, time as dt_time
from zoneinfo import ZoneInfo
from typing import Optional
from bson import ObjectId
from pymongo import ASCENDING
from pymongo.errors import DuplicateKeyError


try:
    IST_TZ = ZoneInfo("Asia/Kolkata")
except Exception:
    IST_TZ = timezone(timedelta(hours=5, minutes=30))


ENTRY_ON_TIME_START = dt_time(hour=9, minute=0)
ENTRY_ON_TIME_END = dt_time(hour=9, minute=30)
EXIT_ON_TIME_START = dt_time(hour=16, minute=30)
EXIT_ON_TIME_END = dt_time(hour=19, minute=0)
AUTO_ABSENT_MARK_TIME = dt_time(hour=17, minute=15)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ist_now() -> datetime:
    return utc_now().astimezone(IST_TZ)


def _to_utc_iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _from_iso(value: str) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None

def _coerce_datetime(value) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        return _from_iso(value)
    return None


def _legacy_hms_to_utc_iso(date_str: Optional[str], hms: Optional[str]) -> Optional[str]:
    date_text = str(date_str or "").strip()
    time_text = str(hms or "").strip()
    if not date_text or not time_text:
        return None
    try:
        # Legacy rows were often emitted from UTC server local time.
        naive = datetime.strptime(f"{date_text} {time_text}", "%Y-%m-%d %H:%M:%S")
        return _to_utc_iso(naive.replace(tzinfo=timezone.utc))
    except Exception:
        return None


def _iso_to_ist_hms(value: Optional[str], fallback: Optional[str] = None) -> Optional[str]:
    dt = _from_iso(value)
    if not dt:
        return fallback
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST_TZ).strftime("%H:%M:%S")


def attendance_time_fields(row: Optional[dict]) -> dict:
    if not isinstance(row, dict):
        return {
            "check_in": None,
            "check_out": None,
            "check_in_at": None,
            "check_out_at": None,
        }

    check_in_at = row.get("check_in_at") or _legacy_hms_to_utc_iso(row.get("date"), row.get("check_in"))
    check_out_at = row.get("check_out_at") or _legacy_hms_to_utc_iso(row.get("date"), row.get("check_out"))

    return {
        "check_in": _iso_to_ist_hms(check_in_at, row.get("check_in")),
        "check_out": _iso_to_ist_hms(check_out_at, row.get("check_out")),
        "check_in_at": check_in_at,
        "check_out_at": check_out_at,
    }


def normalize_attendance_row_times(row: Optional[dict]) -> Optional[dict]:
    if not isinstance(row, dict):
        return row
    normalized = dict(row)
    normalized.update(attendance_time_fields(normalized))
    return normalized


def _entry_status_for_time(now_ist: datetime) -> str:
    """Entry timing status based on IST server time.

    Rules:
    - from 9:00 to 9:30 -> On Time
    - before 9:00 -> On Time
    - after 9:30 -> Late
    """
    now_local_time = now_ist.timetz().replace(tzinfo=None)
    if now_local_time > ENTRY_ON_TIME_END:
        return "Late"
    if now_local_time < ENTRY_ON_TIME_START:
        return "On Time"
    return "On Time"


def _exit_status_for_time(now_ist: datetime) -> str:
    """Exit timing status based on IST server time.

    Rules:
    - before 16:30 -> Left Early
    - 16:30 and later -> On Time Exit
    """
    now_local_time = now_ist.timetz().replace(tzinfo=None)
    return "Left Early" if now_local_time < EXIT_ON_TIME_START else "On Time Exit"


class AttendanceManager:
    """Handles attendance write/read logic and duplicate prevention."""

    def __init__(self, db, on_change=None):
        self.db = db
        self.employees = db.employees
        self.attendance = db.attendance
        self.on_change = on_change
        self._ensure_indexes()

    def _notify_change(self):
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    def _ensure_indexes(self):
        self.employees.create_index([("name", ASCENDING)], unique=True)
        self.employees.create_index([("login_id", ASCENDING)], unique=True, sparse=True)
        self.attendance.create_index([("employee_id", ASCENDING), ("date", ASCENDING)], unique=True)

    def get_employee_by_name(self, name: str):
        return self.employees.find_one({"name": name})

    def _is_employee_active(self, employee: dict) -> bool:
        if not isinstance(employee, dict):
            return False
        status_text = str(employee.get("status") or "").strip().lower()
        if status_text == "inactive":
            return False
        if isinstance(employee.get("is_active"), bool):
            return bool(employee.get("is_active"))
        if isinstance(employee.get("active"), bool):
            return bool(employee.get("active"))
        return True

    def auto_mark_absent_for_date(self, date_str: str) -> int:
        """Auto mark absent for active employees with no attendance after 5:15 PM IST.

        Returns the number of absent rows inserted.
        """
        date_text = str(date_str or "").strip()
        if not date_text:
            return 0

        try:
            target_date = datetime.strptime(date_text, "%Y-%m-%d").date()
        except ValueError:
            return 0

        now_ist = ist_now()
        today_ist = now_ist.date()

        if target_date > today_ist:
            return 0
        if target_date == today_ist and now_ist.timetz().replace(tzinfo=None) < AUTO_ABSENT_MARK_TIME:
            return 0

        existing = list(self.attendance.find({"date": date_text}, {"employee_id": 1}))
        existing_employee_ids = {str(row.get("employee_id")) for row in existing if row.get("employee_id") is not None}

        now_utc = utc_now()
        inserted = 0
        employees = list(self.employees.find({}, {"_id": 1, "name": 1, "status": 1, "is_active": 1, "active": 1}))
        for employee in employees:
            if not self._is_employee_active(employee):
                continue
            employee_id = employee.get("_id")
            if employee_id is None:
                continue
            if str(employee_id) in existing_employee_ids:
                continue

            doc = {
                "employee_id": employee_id,
                "employee_name": employee.get("name") or "",
                "date": date_text,
                "status": "absent",
                "entry_status": None,
                "exit_status": None,
                "timing_status": "Absent",
                "check_in": None,
                "check_in_at": None,
                "check_out": None,
                "check_out_at": None,
                "entry_mode": "auto_absent",
                "exit_mode": None,
                "manual_entry": False,
                "auto_absent": True,
                "created_at": now_utc,
                "updated_at": now_utc,
            }
            try:
                self.attendance.insert_one(doc)
                inserted += 1
            except DuplicateKeyError:
                continue

        if inserted > 0:
            self._notify_change()
        return inserted

    def mark_attendance(self, employee_name: str, source: str = "auto", reference_at: Optional[datetime] = None) -> dict:
        now_utc = utc_now()
        effective_utc = _coerce_datetime(reference_at) if source == "manual" else None
        if effective_utc is None:
            effective_utc = now_utc
        now_ist = effective_utc.astimezone(IST_TZ)
        date_str = now_ist.strftime("%Y-%m-%d")
        time_str = now_ist.strftime("%H:%M:%S")
        now_utc_iso = _to_utc_iso(effective_utc)

        record = self.attendance.find_one({"employee_id": employee["_id"], "date": date_str})

        if not record:
            entry_status = _entry_status_for_time(now_ist)
            self.attendance.insert_one(
                {
                    "employee_id": employee["_id"],
                    "employee_name": employee_name,
                    "date": date_str,
                    "status": entry_status,
                    "entry_status": entry_status,
                    "exit_status": None,
                    "timing_status": entry_status,
                    "check_in_at": now_utc_iso,
                    "check_in": time_str,
                    "check_out": None,
                    "check_out_at": None,
                    "entry_mode": source,
                    "exit_mode": None,
                    "manual_entry": source == "manual",
                    "created_at": effective_utc,
                    "updated_at": now_utc,
                }
            )
            self._notify_change()
            return {
                "status": "checked_in",
                "timing_status": entry_status,
                "attendance_status": {
                    "message": "Attendance marked successfully",
                    "status": entry_status,
                },
                "employee_name": employee_name,
                "date": date_str,
                "check_in_at": now_utc_iso,
                "check_in": time_str,
                "message": "Attendance marked successfully",
                "manual_entry": source == "manual",
            }

        if (
            record
            and not record.get("check_in")
            and not record.get("check_out")
            and (bool(record.get("auto_absent")) or str(record.get("status") or "").strip().lower() == "absent")
        ):
            return {
                "status": "already_absent",
                "timing_status": "Absent",
                "employee_name": employee_name,
                "date": date_str,
                "check_in": None,
                "check_in_at": None,
                "check_out": None,
                "check_out_at": None,
                "message": "Attendance auto-marked absent for today",
                "manual_entry": False,
            }

        # If employee is checked-in but not checked-out yet, mark checkout immediately
        if not record.get("check_out"):
            exit_status = _exit_status_for_time(now_ist)
            self.attendance.update_one(
                {"_id": record["_id"]},
                {
                    "$set": {
                        "status": exit_status,
                        "exit_status": exit_status,
                        "timing_status": exit_status,
                        "check_out": time_str,
                        "check_out_at": now_utc_iso,
                        "exit_mode": source,
                        "manual_entry": bool(record.get("manual_entry")) or source == "manual",
                        "updated_at": now_utc,
                    }
                },
            )
            self._notify_change()

            return {
                "status": "checked_out",
                "timing_status": exit_status,
                "attendance_status": {
                    "message": "Exit attendance marked successfully",
                    "status": exit_status,
                },
                "employee_name": employee_name,
                "date": date_str,
                "check_out_at": now_utc_iso,
                "check_out": time_str,
                "message": "Exit attendance marked successfully",
                "manual_entry": bool(record.get("manual_entry")) or source == "manual",
            }

        # If check-out is already present, do not overwrite; mark as already recorded
        times = attendance_time_fields(record)
        return {
            "status": "already_recorded",
            "timing_status": record.get("timing_status") or record.get("exit_status") or record.get("entry_status"),
            "employee_name": employee_name,
            "date": date_str,
            "message": "Attendance is already marked for today",
            "check_in": times.get("check_in"),
            "check_out": times.get("check_out"),
            "check_in_at": times.get("check_in_at"),
            "check_out_at": times.get("check_out_at"),
            "manual_entry": bool(record.get("manual_entry")),
        }

    def mark_entry(self, employee_name: str, source: str = "login") -> dict:
        employee = self.get_employee_by_name(employee_name)
        if not employee:
            return {"status": "error", "message": f"Employee '{employee_name}' not found"}

        now_utc = utc_now()
        now_ist = now_utc.astimezone(IST_TZ)
        date_str = now_ist.strftime("%Y-%m-%d")
        time_str = now_ist.strftime("%H:%M:%S")
        now_utc_iso = _to_utc_iso(now_utc)

        record = self.attendance.find_one({"employee_id": employee["_id"], "date": date_str})

        if not record:
            entry_status = _entry_status_for_time(now_ist)
            self.attendance.insert_one(
                {
                    "employee_id": employee["_id"],
                    "employee_name": employee_name,
                    "date": date_str,
                    "status": entry_status,
                    "entry_status": entry_status,
                    "exit_status": None,
                    "timing_status": entry_status,
                    "check_in_at": now_utc_iso,
                    "check_in": time_str,
                    "check_out": None,
                    "check_out_at": None,
                    "entry_mode": source,
                    "exit_mode": None,
                    "manual_entry": source == "manual",
                    "created_at": now_utc,
                    "updated_at": now_utc,
                }
            )
            self._notify_change()
            return {
                "status": "checked_in",
                "timing_status": entry_status,
                "employee_name": employee_name,
                "date": date_str,
                "check_in": time_str,
                "check_in_at": now_utc_iso,
                "check_out": None,
                "check_out_at": None,
                "message": "Entry marked successfully",
            }

        times = attendance_time_fields(record)
        if (
            record
            and not record.get("check_in")
            and not record.get("check_out")
            and (bool(record.get("auto_absent")) or str(record.get("status") or "").strip().lower() == "absent")
        ):
            return {
                "status": "already_absent",
                "timing_status": "Absent",
                "employee_name": employee_name,
                "date": date_str,
                "check_in": None,
                "check_in_at": None,
                "check_out": None,
                "check_out_at": None,
                "message": "Attendance auto-marked absent for today",
            }

        if not record.get("check_out"):
            return {
                "status": "already_checked_in",
                "timing_status": record.get("entry_status") or record.get("timing_status"),
                "employee_name": employee_name,
                "date": date_str,
                "check_in": times.get("check_in"),
                "check_in_at": times.get("check_in_at"),
                "check_out": times.get("check_out"),
                "check_out_at": times.get("check_out_at"),
                "message": "Entry already marked for today",
            }

        return {
            "status": "already_recorded",
            "timing_status": record.get("timing_status") or record.get("exit_status") or record.get("entry_status"),
            "employee_name": employee_name,
            "date": date_str,
            "check_in": times.get("check_in"),
            "check_in_at": times.get("check_in_at"),
            "check_out": times.get("check_out"),
            "check_out_at": times.get("check_out_at"),
            "message": "Attendance is already marked for today",
        }

    def mark_exit(self, employee_name: str, source: str = "logout") -> dict:
        employee = self.get_employee_by_name(employee_name)
        if not employee:
            return {"status": "error", "message": f"Employee '{employee_name}' not found"}

        now_utc = utc_now()
        now_ist = now_utc.astimezone(IST_TZ)
        date_str = now_ist.strftime("%Y-%m-%d")
        time_str = now_ist.strftime("%H:%M:%S")
        now_utc_iso = _to_utc_iso(now_utc)

        record = self.attendance.find_one({"employee_id": employee["_id"], "date": date_str})
        if not record:
            return {
                "status": "not_checked_in",
                "employee_name": employee_name,
                "date": date_str,
                "message": "Entry not found for today",
                "check_in": None,
                "check_in_at": None,
                "check_out": None,
                "check_out_at": None,
            }

        if (
            not record.get("check_in")
            and not record.get("check_out")
            and (bool(record.get("auto_absent")) or str(record.get("status") or "").strip().lower() == "absent")
        ):
            return {
                "status": "already_absent",
                "timing_status": "Absent",
                "employee_name": employee_name,
                "date": date_str,
                "check_in": None,
                "check_in_at": None,
                "check_out": None,
                "check_out_at": None,
                "message": "Attendance auto-marked absent for today",
            }

        if record.get("check_out"):
            times = attendance_time_fields(record)
            return {
                "status": "already_recorded",
                "timing_status": record.get("timing_status") or record.get("exit_status") or record.get("entry_status"),
                "employee_name": employee_name,
                "date": date_str,
                "check_in": times.get("check_in"),
                "check_in_at": times.get("check_in_at"),
                "check_out": times.get("check_out"),
                "check_out_at": times.get("check_out_at"),
                "message": "Exit already marked for today",
            }

        exit_status = _exit_status_for_time(now_ist)
        self.attendance.update_one(
            {"_id": record["_id"]},
            {
                "$set": {
                    "status": exit_status,
                    "exit_status": exit_status,
                    "timing_status": exit_status,
                    "check_out": time_str,
                    "check_out_at": now_utc_iso,
                    "exit_mode": source,
                    "manual_entry": bool(record.get("manual_entry")) or source == "manual",
                    "updated_at": now_utc,
                }
            },
        )
        self._notify_change()

        check_in_times = attendance_time_fields(record)
        return {
            "status": "checked_out",
            "timing_status": exit_status,
            "employee_name": employee_name,
            "date": date_str,
            "check_in": check_in_times.get("check_in"),
            "check_in_at": check_in_times.get("check_in_at"),
            "check_out": time_str,
            "check_out_at": now_utc_iso,
            "message": "Exit marked successfully",
        }

    def mark_leave(self, employee_name: str, source: str = "employee") -> dict:
        employee = self.get_employee_by_name(employee_name)
        if not employee:
            return {"status": "error", "message": f"Employee '{employee_name}' not found"}

        now_utc = utc_now()
        now_ist = now_utc.astimezone(IST_TZ)
        date_str = now_ist.strftime("%Y-%m-%d")

        record = self.attendance.find_one({"employee_id": employee["_id"], "date": date_str})
        if not record:
            self.attendance.insert_one(
                {
                    "employee_id": employee["_id"],
                    "employee_name": employee_name,
                    "date": date_str,
                    "status": "Leave",
                    "entry_status": None,
                    "exit_status": None,
                    "timing_status": "On Leave",
                    "check_in_at": None,
                    "check_in": None,
                    "check_out": None,
                    "check_out_at": None,
                    "entry_mode": source,
                    "exit_mode": None,
                    "manual_entry": source == "manual",
                    "leave_marked": True,
                    "created_at": now_utc,
                    "updated_at": now_utc,
                }
            )
            self._notify_change()
            return {
                "status": "leave_marked",
                "timing_status": "On Leave",
                "employee_name": employee_name,
                "date": date_str,
                "check_in": None,
                "check_in_at": None,
                "check_out": None,
                "check_out_at": None,
                "message": "Leave marked successfully",
            }

        times = attendance_time_fields(record)
        current_status = str(record.get("status") or "").strip().lower()
        current_timing_status = str(record.get("timing_status") or "").strip().lower()
        is_leave = bool(record.get("leave_marked")) or current_status == "leave" or current_timing_status == "on leave"
        if is_leave:
            return {
                "status": "already_on_leave",
                "timing_status": "On Leave",
                "employee_name": employee_name,
                "date": date_str,
                "check_in": times.get("check_in"),
                "check_in_at": times.get("check_in_at"),
                "check_out": times.get("check_out"),
                "check_out_at": times.get("check_out_at"),
                "message": "Leave already marked for today",
            }

        is_absent_record = bool(record.get("auto_absent")) or current_status == "absent"
        has_attendance_times = bool(times.get("check_in")) or bool(times.get("check_out"))
        if is_absent_record and not has_attendance_times:
            self.attendance.update_one(
                {"_id": record["_id"]},
                {
                    "$set": {
                        "status": "Leave",
                        "entry_status": None,
                        "exit_status": None,
                        "timing_status": "On Leave",
                        "check_in": None,
                        "check_in_at": None,
                        "check_out": None,
                        "check_out_at": None,
                        "entry_mode": source,
                        "exit_mode": None,
                        "leave_marked": True,
                        "auto_absent": False,
                        "updated_at": now_utc,
                    }
                },
            )
            self._notify_change()
            return {
                "status": "leave_marked",
                "timing_status": "On Leave",
                "employee_name": employee_name,
                "date": date_str,
                "check_in": None,
                "check_in_at": None,
                "check_out": None,
                "check_out_at": None,
                "message": "Leave marked successfully",
            }

        if record.get("check_out"):
            derived_status = "checked_out"
        elif record.get("check_in"):
            derived_status = "checked_in"
        else:
            derived_status = "absent"
        return {
            "status": "attendance_exists",
            "employee_name": employee_name,
            "date": date_str,
            "current_status": derived_status,
            "timing_status": record.get("timing_status") or record.get("exit_status") or record.get("entry_status"),
            "check_in": times.get("check_in"),
            "check_in_at": times.get("check_in_at"),
            "check_out": times.get("check_out"),
            "check_out_at": times.get("check_out_at"),
            "message": "Attendance already marked for today. Leave cannot be marked now",
        }

    def list_attendance(self, date: Optional[str] = None) -> list:
        if date:
            self.auto_mark_absent_for_date(date)

        query = {"date": date} if date else {}
        rows = list(self.attendance.find(query).sort([("date", -1), ("check_in", -1)]))
        if not rows:
            return []

        normalized_rows = []
        for raw_row in rows:
            row = normalize_attendance_row_times(raw_row) or {}
            if "_id" in row:
                row["id"] = str(row.pop("_id"))
            if row.get("employee_id") is not None:
                row["employee_id"] = str(row["employee_id"])
            raw_status = str(row.get("status") or "").strip().lower()
            raw_timing_status = str(row.get("timing_status") or "").strip().lower()
            is_leave = bool(row.get("leave_marked")) or raw_status == "leave" or raw_timing_status == "on leave"
            is_absent = bool(row.get("auto_absent")) or raw_status == "absent"
            if is_leave:
                row["status"] = "leave"
                row["timing_status"] = "On Leave"
            elif is_absent:
                row["status"] = "absent"
                row["timing_status"] = "Absent"
            else:
                row["status"] = "checked_out" if row.get("check_out") else "checked_in"
                row["timing_status"] = row.get("timing_status") or row.get("exit_status") or row.get("entry_status")
            row["manual_entry"] = bool(row.get("manual_entry"))
            row.pop("created_at", None)
            row.pop("updated_at", None)
            normalized_rows.append(row)

        return normalized_rows

    def list_employees(self) -> list:
        rows = list(self.employees.find().sort("name", 1))
        for row in rows:
            row["id"] = str(row.pop("_id"))
            row.pop("password_hash", None)
            row.pop("password_visible_for_admin", None)
            if isinstance(row.get("updated_at"), datetime):
                row["updated_at"] = row["updated_at"].isoformat()
            if isinstance(row.get("password_updated_at"), datetime):
                row["password_updated_at"] = row["password_updated_at"].isoformat()
        return rows

    def update_employee(self, employee_id: str, updates: dict) -> dict:
        employee = self.employees.find_one({"_id": ObjectId(employee_id)})
        if not employee:
            return {"status": "error", "message": "Employee not found"}

        payload = dict(updates or {})
        payload["updated_at"] = ist_now()
        self.employees.update_one({"_id": employee["_id"]}, {"$set": payload})
        self._notify_change()
        updated = self.employees.find_one({"_id": employee["_id"]})
        updated["id"] = str(updated.pop("_id"))
        updated.pop("password_hash", None)
        updated.pop("password_visible_for_admin", None)
        return {"status": "ok", "employee": updated}

    def delete_employee(self, employee_id: str) -> dict:
        employee = self.employees.find_one({"_id": ObjectId(employee_id)})
        if not employee:
            return {"status": "error", "message": "Employee not found"}

        self.employees.delete_one({"_id": employee["_id"]})
        self.attendance.delete_many({"employee_id": employee["_id"]})
        self._notify_change()
        return {"status": "ok", "employee_name": employee.get("name", "unknown")}
