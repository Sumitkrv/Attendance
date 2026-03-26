from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Optional
from bson import ObjectId
from pymongo import ASCENDING


try:
    IST_TZ = ZoneInfo("Asia/Kolkata")
except Exception:
    IST_TZ = timezone(timedelta(hours=5, minutes=30))


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

    def mark_attendance(self, employee_name: str, source: str = "auto") -> dict:
        """
        Attendance rules:
        - first detection in a day -> check-in
        - later detections -> check-out (updates latest check-out)
        """
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
            self.attendance.insert_one(
                {
                    "employee_id": employee["_id"],
                    "employee_name": employee_name,
                    "date": date_str,
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
                "employee_name": employee_name,
                "date": date_str,
                "check_in_at": now_utc_iso,
                "check_in": time_str,
                "manual_entry": source == "manual",
            }

        # If employee is checked-in but not checked-out yet, mark checkout immediately
        if not record.get("check_out"):
            self.attendance.update_one(
                {"_id": record["_id"]},
                {
                    "$set": {
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
                "employee_name": employee_name,
                "date": date_str,
                "check_out_at": now_utc_iso,
                "check_out": time_str,
                "manual_entry": bool(record.get("manual_entry")) or source == "manual",
            }

        # If check-out is already present, do not overwrite; mark as already recorded
        times = attendance_time_fields(record)
        return {
            "status": "already_recorded",
            "employee_name": employee_name,
            "date": date_str,
            "message": "Attendance is already marked for today",
            "check_in": times.get("check_in"),
            "check_out": times.get("check_out"),
            "check_in_at": times.get("check_in_at"),
            "check_out_at": times.get("check_out_at"),
            "manual_entry": bool(record.get("manual_entry")),
        }

    def list_attendance(self, date: Optional[str] = None) -> list:
        query = {"date": date} if date else {}
        rows = list(self.attendance.find(query).sort([("date", -1), ("check_in", -1)]))
        for row in rows:
            row = normalize_attendance_row_times(row)
            row["id"] = str(row.pop("_id"))
            row["employee_id"] = str(row["employee_id"])
            row["status"] = "checked_out" if row.get("check_out") else "checked_in"
            row["manual_entry"] = bool(row.get("manual_entry"))
            row.pop("created_at", None)
            row.pop("updated_at", None)
        return rows

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
