import os
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps

import jwt
from flask import g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash


def _secret_key() -> str:
    return os.getenv("SECRET_KEY", "dev-secret-change-me")


def _is_production_env() -> bool:
    app_env = str(os.getenv("APP_ENV") or os.getenv("FLASK_ENV") or "").strip().lower()
    return app_env in {"prod", "production"}


def _token_expiry_minutes(primary_env: str, default_minutes: int = 10080) -> int:
    raw_primary = os.getenv(primary_env)
    if raw_primary is not None and str(raw_primary).strip() != "":
        try:
            value = int(str(raw_primary).strip())
            if value > 0:
                return value
        except (TypeError, ValueError):
            pass

    # Backward-compatible fallback, but avoid very short expiries that cause daily re-login issues.
    raw_legacy = os.getenv("JWT_EXPIRES_MIN")
    if raw_legacy is not None and str(raw_legacy).strip() != "":
        try:
            value = int(str(raw_legacy).strip())
            if value >= 1440:
                return value
        except (TypeError, ValueError):
            pass

    return default_minutes


def get_admin_token_expiry_minutes() -> int:
    return _token_expiry_minutes("JWT_ADMIN_EXPIRES_MIN")


def get_user_token_expiry_minutes() -> int:
    return _token_expiry_minutes("JWT_USER_EXPIRES_MIN", default_minutes=120)


def get_token_policy() -> dict:
    return {
        "admin_expires_min": get_admin_token_expiry_minutes(),
        "user_expires_min": get_user_token_expiry_minutes(),
    }


def issue_admin_token(username: str) -> str:
    expires_min = get_admin_token_expiry_minutes()
    payload = {
        "sub": username,
        "role": "admin",
        "jti": uuid.uuid4().hex,
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=expires_min),
    }
    return jwt.encode(payload, _secret_key(), algorithm="HS256")


def decode_admin_token(token: str) -> dict:
    return jwt.decode(token, _secret_key(), algorithms=["HS256"])


def issue_user_token(employee_id: str, employee_name: str, login_id: str, must_change_password: bool = False) -> str:
    expires_min = get_user_token_expiry_minutes()
    payload = {
        "sub": login_id,
        "role": "user",
        "employee_id": employee_id,
        "employee_name": employee_name,
        "login_id": login_id,
        "must_change_password": bool(must_change_password),
        "jti": uuid.uuid4().hex,
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=expires_min),
    }
    return jwt.encode(payload, _secret_key(), algorithm="HS256")


def refresh_admin_token(claims: dict) -> str:
    username = str(claims.get("sub") or "").strip()
    return issue_admin_token(username)


def refresh_user_token(claims: dict) -> str:
    return issue_user_token(
        employee_id=str(claims.get("employee_id") or ""),
        employee_name=str(claims.get("employee_name") or ""),
        login_id=str(claims.get("login_id") or claims.get("sub") or ""),
        must_change_password=bool(claims.get("must_change_password")),
    )


def decode_user_token(token: str) -> dict:
    return jwt.decode(token, _secret_key(), algorithms=["HS256"])


def admin_auth_required(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"message": "Missing bearer token"}), 401

        token = auth_header.split(" ", 1)[1].strip()
        if not token:
            return jsonify({"message": "Invalid token"}), 401

        try:
            claims = decode_admin_token(token)
            if claims.get("role") != "admin":
                return jsonify({"message": "Unauthorized role"}), 403
            g.admin_claims = claims
        except jwt.ExpiredSignatureError:
            return jsonify({"message": "Please log in again"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"message": "Invalid token"}), 401

        return handler(*args, **kwargs)

    return wrapped


def user_auth_required(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"message": "Missing bearer token"}), 401

        token = auth_header.split(" ", 1)[1].strip()
        if not token:
            return jsonify({"message": "Invalid token"}), 401

        try:
            claims = decode_user_token(token)
            if claims.get("role") != "user":
                return jsonify({"message": "Unauthorized role"}), 403
            g.user_claims = claims
        except jwt.ExpiredSignatureError:
            return jsonify({"message": "Please log in again"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"message": "Invalid token"}), 401

        return handler(*args, **kwargs)

    return wrapped


def verify_admin_credentials(username: str, password: str) -> bool:
    expected_user = os.getenv("ADMIN_USERNAME", "admin")
    if username != expected_user:
        return False

    # Prefer hash in production. Fallback to plain text for local setup.
    expected_hash = os.getenv("ADMIN_PASSWORD_HASH", "").strip()
    if expected_hash:
        return check_password_hash(expected_hash, password)

    if _is_production_env():
        return False

    expected_plain = os.getenv("ADMIN_PASSWORD", "admin123")
    return password == expected_plain


def build_password_hash(password: str) -> str:
    return generate_password_hash(password, method="pbkdf2:sha256")
