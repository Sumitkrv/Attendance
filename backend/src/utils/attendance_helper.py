from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional


def _parse_iso_datetime(value: Any) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_date_text(value: Any) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _parse_hms(value: Any) -> Optional[tuple[int, int, int]]:
    text = str(value or "").strip()
    if not text:
        return None
    chunks = text.split(":")
    if len(chunks) < 2:
        return None
    try:
        hh = int(chunks[0])
        mm = int(chunks[1])
        ss = int(chunks[2]) if len(chunks) > 2 else 0
    except (TypeError, ValueError):
        return None
    if hh < 0 or hh > 23 or mm < 0 or mm > 59 or ss < 0 or ss > 59:
        return None
    return hh, mm, ss


def _entry_dt_utc(row: Dict[str, Any]) -> Optional[datetime]:
    check_in_at = _parse_iso_datetime(row.get("check_in_at"))
    if check_in_at is not None:
        return check_in_at

    date_dt = _parse_date_text(row.get("date"))
    hms = _parse_hms(row.get("check_in"))
    if date_dt is None or hms is None:
        return None
    hh, mm, ss = hms
    return date_dt.replace(hour=hh, minute=mm, second=ss)


def _is_late_row(row: Dict[str, Any]) -> bool:
    for key in ("timing_status", "entry_status", "status"):
        value = str(row.get(key) or "").strip().lower()
        if "late" in value:
            return True
    return False


def _delay_minutes(row: Dict[str, Any], late_cutoff_hour: int = 9, late_cutoff_minute: int = 30) -> int:
    cached = row.get("late_by_minutes")
    if isinstance(cached, (int, float)):
        return max(0, int(cached))

    hms = _parse_hms(row.get("check_in"))
    if hms is None:
        check_in_at = _entry_dt_utc(row)
        if check_in_at is None:
            return 0
        hh, mm, _ = check_in_at.hour, check_in_at.minute, check_in_at.second
    else:
        hh, mm, _ = hms

    total = (hh * 60) + mm
    cutoff = (late_cutoff_hour * 60) + late_cutoff_minute
    return max(0, total - cutoff)


def late_stats_last_7_days(
    attendance_collection,
    employee_id,
    *,
    reference_utc: Optional[datetime] = None,
    late_cutoff_hour: int = 9,
    late_cutoff_minute: int = 30,
) -> Dict[str, Any]:
    now = reference_utc or datetime.now(timezone.utc)
    now = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    end_date = now.date()
    start_date = end_date - timedelta(days=6)

    rows = list(
        attendance_collection.find(
            {
                "employee_id": employee_id,
                "date": {"$gte": start_date.isoformat(), "$lte": end_date.isoformat()},
            }
        )
    )

    late_rows = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if _is_late_row(row):
            late_rows.append(row)

    latest_delay = 0
    latest_at: Optional[datetime] = None
    for row in late_rows:
        stamp = _entry_dt_utc(row) or _parse_date_text(row.get("date"))
        delay = _delay_minutes(row, late_cutoff_hour=late_cutoff_hour, late_cutoff_minute=late_cutoff_minute)
        if latest_at is None or (stamp is not None and stamp > latest_at):
            latest_at = stamp
            latest_delay = delay

    return {
        "late_count": len(late_rows),
        "latest_delay": int(latest_delay),
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
    }
