from datetime import datetime
from pydantic import BaseModel


class AttendanceRecord(BaseModel):
    user_id: str
    status: str
    timestamp: datetime
    face_verified: bool
    location_verified: bool
