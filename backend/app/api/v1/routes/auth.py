from base64 import b64decode, b64encode
from datetime import datetime, timedelta, timezone
import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Header, status

from app.schemas.auth import LoginRequest, LoginResponse

router = APIRouter(tags=["Auth"])


def _encode_token(payload: dict) -> str:
    header = {"alg": "none", "typ": "JWT"}
    return ".".join(
        b64encode(json.dumps(part, separators=(",", ":")).encode("utf-8")).decode("utf-8")
        for part in (header, payload)
    ) + "."


def _decode_token(token: str) -> dict:
    try:
        segments = StringParts = StringLike = str(token or "").split(".")
        if len(segments) < 2:
            return {}
        raw = segments[1]
        padding = "=" * (-len(raw) % 4)
        return json.loads(b64decode(raw + padding).decode("utf-8"))
    except Exception:
        return {}


def _build_login_response(*, role: str, identifier: str, display_name: str, email: str = "", login_id: str = "") -> LoginResponse:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(days=7)
    token_payload = {
        "sub": login_id or identifier or "u_001",
        "role": role,
        "name": display_name,
        "username": identifier if role == "admin" else "",
        "email": email,
        "login_id": login_id,
        "employee_name": display_name,
        "must_change_password": False,
        "user_id": login_id or "u_001",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }

    return LoginResponse(
        success=True,
        message="Login successful",
        data={
            "token": _encode_token(token_payload),
            "user_id": login_id or "u_001",
            "name": display_name,
            "role": role,
            "username": identifier if role == "admin" else login_id,
            "email": email,
            "employee": {
                "name": display_name,
                "login_id": login_id,
                "department": "General",
                "must_change_password": False,
            } if role == "user" else None,
        },
    )


def _refresh_token(authorization: Optional[str], expected_role: str) -> LoginResponse:
    token = str(authorization or "")
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    payload = _decode_token(token)
    if str(payload.get("role", "")).lower() != expected_role:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    now = datetime.now(timezone.utc)
    exp = now + timedelta(days=7)
    payload.update({"iat": int(now.timestamp()), "exp": int(exp.timestamp())})
    return LoginResponse(
        success=True,
        message="Token refreshed",
        data={"token": _encode_token(payload)},
    )


@router.post("/login", response_model=LoginResponse)
@router.post("/admin/login", response_model=LoginResponse)
@router.post("/user/login", response_model=LoginResponse)
def login(payload: LoginRequest):
    email = str(payload.email or "").strip().lower()
    username = str(payload.username or "").strip().lower()
    login_id = str(payload.login_id or "").strip().lower()
    is_admin_login = (
        (email == "admin@company.com" or username == "admin")
        and payload.password == "123456"
    )

    if is_admin_login:
        return _build_login_response(
            role="admin",
            identifier=username or "admin",
            display_name="Admin",
            email=email or "admin@company.com",
            login_id="u_001",
        )

    if login_id and payload.password == "123456":
        employee_name = login_id.replace(".", " ").replace("_", " ").title() or "Employee"
        return _build_login_response(
            role="user",
            identifier=login_id,
            display_name=employee_name,
            login_id=login_id,
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
    )


@router.post("/auth/refresh_admin", response_model=LoginResponse)
def refresh_admin(authorization: Optional[str] = Header(default=None)):
    return _refresh_token(authorization, "admin")


@router.post("/auth/refresh_user", response_model=LoginResponse)
def refresh_user(authorization: Optional[str] = Header(default=None)):
    return _refresh_token(authorization, "user")

