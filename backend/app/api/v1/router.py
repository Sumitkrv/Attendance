from fastapi import APIRouter

from app.api.v1.routes.attendance import router as attendance_router
from app.api.v1.routes.auth import router as auth_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(attendance_router)
