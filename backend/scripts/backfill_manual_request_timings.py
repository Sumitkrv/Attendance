from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, time as dt_time, timezone, timedelta
from pathlib import Path
from typing import Optional

from pymongo import MongoClient


try:
    from zoneinfo import ZoneInfo
    IST_TZ = ZoneInfo("Asia/Kolkata")
except Exception:
    IST_TZ = timezone(timedelta(hours=5, minutes=30))


ENTRY_ON_TIME_END = dt_time(hour=9, minute=30)


def read_env(path: Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def parse_datetime(value) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None


def to_utc_iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def entry_status_for(request_time: datetime) -> str:
    local_time = request_time.astimezone(IST_TZ).timetz().replace(tzinfo=None)
    return "Late" if local_time > ENTRY_ON_TIME_END else "On Time"


def find_env_file() -> Path:
    explicit_value = str(os.getenv("ENV_FILE", "")).strip()
    if explicit_value:
        explicit = Path(explicit_value)
        if explicit.exists():
            return explicit
    base_dir = Path(__file__).resolve().parents[1]
    for candidate in (base_dir / ".env", base_dir / ".env.dev", base_dir / ".env.staging"):
        if candidate.exists():
            return candidate
    return base_dir / ".env"


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill manual request timings from request creation time")
    parser.add_argument("--apply", action="store_true", help="Apply updates to MongoDB")
    args = parser.parse_args()

    env = read_env(find_env_file())
    uri = env.get("MONGODB_URI", "mongodb://localhost:27017")
    db_name = env.get("MONGODB_DB", "face_attendance")

    client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    db = client[db_name]

    approved_requests = list(db.manual_requests.find({"status": "approved"}))
    request_alias_updates = 0
    attendance_updates = []
    attendance_matches = 0

    for request in approved_requests:
        request_id = request.get("_id")
        employee_name = str(request.get("employee_name") or "").strip()
        request_date = str(request.get("date") or "").strip()
        requested_at = parse_datetime(request.get("requested_at") or request.get("created_at"))
        if not employee_name or not request_date or requested_at is None:
            continue

        if args.apply and not request.get("requested_at"):
            db.manual_requests.update_one(
                {"_id": request_id},
                {"$set": {"requested_at": requested_at}},
            )
            request_alias_updates += 1

        attendance = db.attendance.find_one(
            {
                "employee_name": employee_name,
                "date": request_date,
                "manual_entry": True,
            }
        )
        if not attendance:
            continue

        attendance_matches += 1
        request_ist = requested_at.astimezone(IST_TZ)
        check_in_hms = request_ist.strftime("%H:%M:%S")
        check_in_at = to_utc_iso(requested_at)
        timing_status = entry_status_for(requested_at)
        update_doc = {
            "check_in": check_in_hms,
            "check_in_at": check_in_at,
            "status": timing_status,
            "entry_status": timing_status,
            "timing_status": timing_status,
            "created_at": requested_at,
            "updated_at": requested_at,
        }
        if not str(attendance.get("manual_reason") or "").strip() and request.get("reason"):
            update_doc["manual_reason"] = request.get("reason")
        if not str(attendance.get("entry_mode") or "").strip():
            update_doc["entry_mode"] = "manual"
        if not bool(attendance.get("manual_entry")):
            update_doc["manual_entry"] = True

        current = {
            "check_in": attendance.get("check_in"),
            "check_in_at": attendance.get("check_in_at"),
            "status": attendance.get("status"),
            "entry_status": attendance.get("entry_status"),
            "timing_status": attendance.get("timing_status"),
            "manual_reason": attendance.get("manual_reason"),
            "created_at": attendance.get("created_at"),
            "updated_at": attendance.get("updated_at"),
            "entry_mode": attendance.get("entry_mode"),
            "manual_entry": attendance.get("manual_entry"),
        }

        needs_update = any(current.get(key) != value for key, value in update_doc.items())
        if not needs_update:
            continue

        if args.apply:
            db.attendance.update_one({"_id": attendance["_id"]}, {"$set": update_doc})
        attendance_updates.append(
            {
                "employee_name": employee_name,
                "date": request_date,
                "request_id": str(request_id),
                "requested_at": requested_at.isoformat(),
                "timing_status": timing_status,
            }
        )

    if args.apply:
        try:
            from backend.src.api.app import persist_mock_db_now  # type: ignore

            persist_mock_db_now()
        except Exception:
            pass

    print(
        json.dumps(
            {
                "ok": True,
                "mode": "apply" if args.apply else "dry-run",
                "approved_requests_scanned": len(approved_requests),
                "manual_request_requested_at_aliases_added": request_alias_updates,
                "attendance_rows_matched": attendance_matches,
                "attendance_rows_updated": len(attendance_updates),
                "updates": attendance_updates[:200],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())