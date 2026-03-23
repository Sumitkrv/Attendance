from datetime import datetime
from typing import Optional
from bson import ObjectId
from pymongo import ASCENDING


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

        now = datetime.now()
        date_str = now.strftime("%Y-%m-%d")
        time_str = now.strftime("%H:%M:%S")

        record = self.attendance.find_one({"employee_id": employee["_id"], "date": date_str})

        if not record:
            self.attendance.insert_one(
                {
                    "employee_id": employee["_id"],
                    "employee_name": employee_name,
                    "date": date_str,
                    "check_in": time_str,
                    "check_out": None,
                    "entry_mode": source,
                    "exit_mode": None,
                    "manual_entry": source == "manual",
                    "created_at": now,
                    "updated_at": now,
                }
            )
            self._notify_change()
            return {
                "status": "checked_in",
                "employee_name": employee_name,
                "date": date_str,
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
                        "exit_mode": source,
                        "manual_entry": bool(record.get("manual_entry")) or source == "manual",
                        "updated_at": now,
                    }
                },
            )
            self._notify_change()

            return {
                "status": "checked_out",
                "employee_name": employee_name,
                "date": date_str,
                "check_out": time_str,
                "manual_entry": bool(record.get("manual_entry")) or source == "manual",
            }

        # If check-out is already present, do not overwrite; mark as already recorded
        return {
            "status": "already_recorded",
            "employee_name": employee_name,
            "date": date_str,
            "message": "Attendance is already marked for today",
            "check_in": record.get("check_in"),
            "check_out": record.get("check_out"),
            "manual_entry": bool(record.get("manual_entry")),
        }

    def list_attendance(self, date: Optional[str] = None) -> list:
        query = {"date": date} if date else {}
        rows = list(self.attendance.find(query).sort([("date", -1), ("check_in", -1)]))
        for row in rows:
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
        payload["updated_at"] = datetime.now()
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
