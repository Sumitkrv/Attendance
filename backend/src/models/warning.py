from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List


class WarningRepository:
    def __init__(self, db):
        self.collection = db.warning_logs

    def ensure_indexes(self):
        self.collection.create_index([("employee_id", 1), ("created_at", -1)])
        self.collection.create_index([("created_at", -1)])
        self.collection.create_index([("employee_id", 1), ("auto_generated", 1), ("created_at", -1)])

    @staticmethod
    def _serialize(row: Dict[str, Any]) -> Dict[str, Any]:
        item = dict(row or {})
        if "_id" in item:
            item["id"] = str(item.pop("_id"))
        if item.get("employee_id") is not None:
            item["employee_id"] = str(item.get("employee_id"))
        created_at = item.get("created_at")
        if isinstance(created_at, datetime):
            item["created_at"] = created_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return item

    def insert_warning(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        doc = dict(payload or {})
        doc.setdefault("created_at", datetime.now(timezone.utc))
        inserted = self.collection.insert_one(doc)
        row = self.collection.find_one({"_id": inserted.inserted_id})
        return self._serialize(row)

    def list_history(self, employee_id, limit: int = 25) -> List[Dict[str, Any]]:
        rows = list(
            self.collection.find({"employee_id": employee_id}).sort("created_at", -1).limit(max(1, min(int(limit), 200)))
        )
        return [self._serialize(row) for row in rows]

    def warning_counts(self) -> List[Dict[str, Any]]:
        pipeline = [
            {"$group": {"_id": "$employee_id", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
        ]
        rows = list(self.collection.aggregate(pipeline))
        return [{"employee_id": str(row.get("_id")), "count": int(row.get("count") or 0)} for row in rows if row.get("_id") is not None]

    def has_auto_warning_today(self, employee_id, reason: str) -> bool:
        now = datetime.now(timezone.utc)
        start_day = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        end_day = start_day.replace(hour=23, minute=59, second=59, microsecond=999999)
        row = self.collection.find_one(
            {
                "employee_id": employee_id,
                "auto_generated": True,
                "reason": reason,
                "created_at": {"$gte": start_day, "$lte": end_day},
            },
            {"_id": 1},
        )
        return bool(row)
