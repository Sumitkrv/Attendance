from fastapi import APIRouter, HTTPException, status

from app.schemas.auth import LoginRequest, LoginResponse

router = APIRouter(tags=["Auth"])


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest):
    if payload.email == "admin@company.com" and payload.password == "123456":
        return LoginResponse(
            success=True,
            message="Login successful",
            data={"token": "sample-jwt-token", "user_id": "u_001", "name": "Admin"},
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
    )
