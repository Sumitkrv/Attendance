import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Union

_IST = timezone(timedelta(hours=5, minutes=30))

ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def now_local() -> datetime:
    """Return current IST datetime."""
    return datetime.now(_IST)


def today_str() -> str:
    """Return today's date in YYYY-MM-DD."""
    return now_local().strftime("%Y-%m-%d")


def time_str() -> str:
    """Return current time in HH:MM:SS."""
    return now_local().strftime("%H:%M:%S")


def ensure_dir(path: Union[str, Path]) -> Path:
    """Create directory if it does not exist."""
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def slugify_name(name: str) -> str:
    """Convert employee name to a safe folder name."""
    cleaned = re.sub(r"[^a-zA-Z0-9\s-]", "", name).strip().lower()
    return re.sub(r"[\s-]+", "_", cleaned)


def is_image_file(filename: str) -> bool:
    return Path(filename).suffix.lower() in ALLOWED_IMAGE_EXTENSIONS


def env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default
