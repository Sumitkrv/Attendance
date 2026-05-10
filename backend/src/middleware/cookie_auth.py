# ==========================================================================
# Item 7: httpOnly Cookie JWT Middleware
# Supports BOTH Bearer token (header) and httpOnly cookie-based auth.
# The cookie approach is more secure against XSS attacks.
#
# Usage: After login, set the cookie in the response:
#   response.set_cookie("fa_admin_jwt", token, httponly=True, samesite="Strict", secure=True, max_age=...)
# ==========================================================================
import os
from functools import wraps

# Cookie names
ADMIN_COOKIE_NAME = os.getenv("ADMIN_COOKIE_NAME", "fa_admin_jwt")
USER_COOKIE_NAME = os.getenv("USER_COOKIE_NAME", "fa_user_jwt")

# SameSite and Secure flags
COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "Lax")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").strip().lower() in {"1", "true", "yes"}
COOKIE_DOMAIN = os.getenv("COOKIE_DOMAIN") or None


def set_auth_cookie(response, token: str, cookie_name: str, max_age_seconds: int = 86400):
    """Set an httpOnly JWT cookie on a Flask response."""
    response.set_cookie(
        cookie_name,
        token,
        httponly=True,
        samesite=COOKIE_SAMESITE,
        secure=COOKIE_SECURE,
        max_age=max_age_seconds,
        path="/",
        domain=COOKIE_DOMAIN,
    )
    return response


def clear_auth_cookie(response, cookie_name: str):
    """Clear an httpOnly JWT cookie."""
    response.set_cookie(
        cookie_name,
        "",
        httponly=True,
        samesite=COOKIE_SAMESITE,
        secure=COOKIE_SECURE,
        max_age=0,
        path="/",
        domain=COOKIE_DOMAIN,
    )
    return response


def extract_token_from_request_or_cookie(request_obj, cookie_name: str) -> str:
    """
    Extract JWT token from Authorization header OR httpOnly cookie.
    Header takes precedence over cookie for backward compatibility.
    """
    # 1. Try Authorization header first
    auth_header = request_obj.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
        if token:
            return token

    # 2. Fallback to httpOnly cookie
    cookie_token = request_obj.cookies.get(cookie_name, "").strip()
    if cookie_token:
        return cookie_token

    return ""
