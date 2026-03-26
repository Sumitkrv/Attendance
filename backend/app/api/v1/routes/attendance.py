from datetime import datetime, timedelta, timezone

_IST = timezone(timedelta(hours=5, minutes=30))
from typing import List

from fastapi import APIRouter, HTTPException, status

from app.schemas.attendance import (
    AttendanceHistoryItem,
    MarkAttendanceRequest,
    MarkAttendanceResponse,
)
from app.services.face_recognition_service import verify_face
from app.services.location_service import is_within_allowed_radius

router = APIRouter(tags=["Attendance"])


@router.post("/mark-attendance", response_model=MarkAttendanceResponse)
def mark_attendance(payload: MarkAttendanceRequest):
    face_verified = verify_face(payload.user_id, payload.image_base64)
    if not face_verified:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Face verification failed",
        )

    location_verified = is_within_allowed_radius(payload.latitude, payload.longitude)
    if not location_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Outside allowed office radius",
        )

    # TODO: persist attendance in DB layer
    return MarkAttendanceResponse(
        success=True,
        message="Attendance marked successfully",
        data={
            "user_id": payload.user_id,
            "timestamp": datetime.now(_IST).isoformat(),
            "face_verified": face_verified,
            "location_verified": location_verified,
        },
    )


@router.get("/attendance-history/{user_id}", response_model=List[AttendanceHistoryItem])
def attendance_history(user_id: str):
    # TODO: fetch from DB layer
    return [
        AttendanceHistoryItem(
            user_id=user_id,
            status="PRESENT",
            timestamp=datetime.now(_IST),
            location_verified=True,
            face_verified=True,
        )
    ]
