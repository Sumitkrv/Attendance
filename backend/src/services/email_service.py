from __future__ import annotations

import json
import os
import smtplib
from email.message import EmailMessage
from typing import Optional, Tuple
from urllib import request as urllib_request


def _build_warning_body(name: str, late_count: int, latest_delay: int) -> str:
    return (
        f"Dear {name},\n\n"
        f"You have been marked late {late_count} times in the past week.\n"
        f"Your latest delay was {latest_delay} minutes.\n\n"
        "Please improve your attendance to avoid further action.\n\n"
        "Regards,\n"
        "HR Team\n"
    )


def _send_via_sendgrid(to_email: str, subject: str, body: str, sender: str) -> Tuple[bool, Optional[str]]:
    api_key = str(os.getenv("SENDGRID_API_KEY", "")).strip()
    if not api_key:
        return False, "SENDGRID_API_KEY is not configured"

    payload = {
        "personalizations": [{"to": [{"email": to_email}]}],
        "from": {"email": sender},
        "subject": subject,
        "content": [{"type": "text/plain", "value": body}],
    }
    raw = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(
        "https://api.sendgrid.com/v3/mail/send",
        data=raw,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib_request.urlopen(req, timeout=10) as response:
            code = int(getattr(response, "status", 0) or 0)
        if code in {200, 201, 202}:
            return True, None
        return False, f"SendGrid returned HTTP {code}"
    except Exception as exc:
        return False, str(exc)


def _send_via_smtp(to_email: str, subject: str, body: str, sender: str) -> Tuple[bool, Optional[str]]:
    user = str(os.getenv("EMAIL_USER", "")).strip()
    password = str(os.getenv("EMAIL_PASS", "")).strip()
    if not user or not password:
        return False, "EMAIL_USER/EMAIL_PASS not configured"

    smtp_host = str(os.getenv("SMTP_HOST", "smtp.gmail.com")).strip() or "smtp.gmail.com"
    smtp_port = int(str(os.getenv("SMTP_PORT", "465")).strip() or "465")

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)

    try:
        with smtplib.SMTP_SSL(host=smtp_host, port=smtp_port, timeout=15) as server:
            server.login(user, password)
            server.send_message(msg)
        return True, None
    except Exception as exc:
        return False, str(exc)


def send_warning_email(employee_name: str, employee_email: str, late_count: int, latest_delay: int) -> Tuple[bool, Optional[str], str]:
    name = str(employee_name or "Employee").strip() or "Employee"
    to_email = str(employee_email or "").strip().lower()
    if not to_email:
        return False, "Employee email is missing", "none"

    sender = str(os.getenv("EMAIL_SENDER", "")).strip() or str(os.getenv("EMAIL_USER", "")).strip() or "hr@localhost"
    subject = "⚠️ Attendance Warning"
    body = _build_warning_body(name, int(late_count or 0), int(latest_delay or 0))

    prefer_sendgrid = str(os.getenv("EMAIL_PROVIDER", "sendgrid")).strip().lower() != "smtp"
    if prefer_sendgrid:
        ok, err = _send_via_sendgrid(to_email, subject, body, sender)
        if ok:
            return True, None, "sendgrid"
        smtp_ok, smtp_err = _send_via_smtp(to_email, subject, body, sender)
        if smtp_ok:
            return True, None, "smtp"
        return False, f"sendgrid={err}; smtp={smtp_err}", "none"

    ok, err = _send_via_smtp(to_email, subject, body, sender)
    if ok:
        return True, None, "smtp"

    sg_ok, sg_err = _send_via_sendgrid(to_email, subject, body, sender)
    if sg_ok:
        return True, None, "sendgrid"

    return False, f"smtp={err}; sendgrid={sg_err}", "none"
