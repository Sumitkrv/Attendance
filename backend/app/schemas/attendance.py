from datetime import datetime
from typing import Any, Dict

from pydantic import BaseModel, Field


class MarkAttendanceRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    latitude: float
    longitude: float
    image_base64: str = Field(..., min_length=10)


class MarkAttendanceResponse(BaseModel):
    success: bool
    message: str
    data: Dict[str, Any]


class AttendanceHistoryItem(BaseModel):
    user_id: str
    status: str
    timestamp: datetime
    location_verified: bool
    face_verified: bool
