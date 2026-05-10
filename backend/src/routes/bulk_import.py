# ==========================================================================
# Item 6: Bulk Employee Import
# Supports CSV/Excel upload for mass employee registration.
# ==========================================================================
import csv
import io
import json
from datetime import datetime, timezone
from flask import Blueprint, g, jsonify, request
from werkzeug.security import generate_password_hash

bulk_import_bp = Blueprint("bulk_import", __name__)


def _get_db():
    from flask import current_app
    return current_app.config.get("_db")


REQUIRED_FIELDS = ["name", "login_id"]
OPTIONAL_FIELDS = [
    "department", "designation", "email", "phone", "address",
    "join_date", "salary", "shift_code", "status",
    "emergency_contact_name", "emergency_contact_phone",
]
ALL_FIELDS = REQUIRED_FIELDS + OPTIONAL_FIELDS


@bulk_import_bp.route("/api/employees/bulk-import/template", methods=["GET"])
def download_template():
    """Return CSV template for bulk import."""
    headers = [
        "name", "login_id", "password", "department", "designation",
        "email", "phone", "address", "join_date", "salary",
        "shift_code", "status", "emergency_contact_name", "emergency_contact_phone",
    ]
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(headers)
    # Example rows
    writer.writerow([
        "John Doe", "john.doe", "TempPass123", "Engineering", "Software Engineer",
        "john@example.com", "+91-9876543210", "Mumbai, India", "2025-01-15", "50000",
        "GEN", "active", "Jane Doe", "+91-9876543211",
    ])
    writer.writerow([
        "Priya Sharma", "priya.sharma", "TempPass456", "HR", "HR Manager",
        "priya@example.com", "+91-9876543212", "Delhi, India", "2024-06-01", "65000",
        "GEN", "active", "Raj Sharma", "+91-9876543213",
    ])

    csv_content = output.getvalue()
    from flask import Response
    return Response(
        csv_content,
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=employee_import_template.csv"},
    )


@bulk_import_bp.route("/api/employees/bulk-import/validate", methods=["POST"])
def validate_import():
    """Validate CSV/JSON data before importing."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    data = _parse_upload(request)
    if isinstance(data, tuple):
        return data  # Error response

    results = {"valid": [], "errors": [], "warnings": [], "total": len(data)}
    existing_logins = set()
    for emp in db.employees.find({}, {"login_id": 1}):
        existing_logins.add((emp.get("login_id") or "").lower())

    seen_logins = set()
    for i, row in enumerate(data, 1):
        row_errors = []
        row_warnings = []

        name = (row.get("name") or "").strip()
        login_id = (row.get("login_id") or "").strip().lower()

        if not name:
            row_errors.append("Name is required")
        if not login_id:
            row_errors.append("Login ID is required")
        elif login_id in existing_logins:
            row_errors.append(f"Login ID '{login_id}' already exists in the system")
        elif login_id in seen_logins:
            row_errors.append(f"Duplicate login ID '{login_id}' in import data")

        password = (row.get("password") or "").strip()
        if not password:
            row_warnings.append("No password provided — will generate default")

        if row_errors:
            results["errors"].append({"row": i, "data": row, "errors": row_errors})
        else:
            results["valid"].append({"row": i, "data": row, "warnings": row_warnings})
            seen_logins.add(login_id)
            if row_warnings:
                results["warnings"].extend([{"row": i, "warning": w} for w in row_warnings])

    return jsonify(results)


@bulk_import_bp.route("/api/employees/bulk-import", methods=["POST"])
def bulk_import():
    """Import employees from CSV/JSON data."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    data = _parse_upload(request)
    if isinstance(data, tuple):
        return data

    imported = 0
    skipped = 0
    errors = []

    for i, row in enumerate(data, 1):
        name = (row.get("name") or "").strip()
        login_id = (row.get("login_id") or "").strip().lower()

        if not name or not login_id:
            errors.append({"row": i, "error": "Missing name or login_id"})
            skipped += 1
            continue

        if db.employees.find_one({"login_id": login_id}):
            errors.append({"row": i, "error": f"Login ID '{login_id}' already exists"})
            skipped += 1
            continue

        password = (row.get("password") or "").strip() or f"PRHR@{login_id[:4]}2025"
        password_hash = generate_password_hash(password)

        doc = {
            "name": name,
            "login_id": login_id,
            "password_hash": password_hash,
            "department": (row.get("department") or "General").strip(),
            "designation": (row.get("designation") or "").strip(),
            "email": (row.get("email") or "").strip(),
            "phone": (row.get("phone") or "").strip(),
            "address": (row.get("address") or "").strip(),
            "join_date": (row.get("join_date") or "").strip(),
            "salary": _safe_float(row.get("salary")),
            "shift_code": (row.get("shift_code") or "GEN").strip().upper(),
            "status": (row.get("status") or "active").strip().lower(),
            "emergency_contact": {
                "name": (row.get("emergency_contact_name") or "").strip(),
                "phone": (row.get("emergency_contact_phone") or "").strip(),
            },
            "must_change_password": True,
            "created_at": datetime.now(timezone.utc),
            "created_via": "bulk_import",
        }
        db.employees.insert_one(doc)
        imported += 1

    return jsonify({
        "message": f"Import complete: {imported} imported, {skipped} skipped",
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
    })


def _parse_upload(req):
    """Parse CSV or JSON from request (file upload or JSON body)."""
    # Check for file upload
    if "file" in req.files:
        file = req.files["file"]
        filename = (file.filename or "").lower()

        if filename.endswith(".csv"):
            content = file.read().decode("utf-8-sig")
            reader = csv.DictReader(io.StringIO(content))
            return [dict(row) for row in reader]

        elif filename.endswith(".json"):
            content = file.read().decode("utf-8")
            data = json.loads(content)
            return data if isinstance(data, list) else [data]

        else:
            return jsonify({"message": "Unsupported file format. Use CSV or JSON."}), 400

    # Check for JSON body
    payload = req.get_json(silent=True) or {}
    employees = payload.get("employees", [])
    if employees:
        return employees

    return jsonify({"message": "No data provided. Upload a CSV/JSON file or send JSON body."}), 400


def _safe_float(val):
    """Safely convert to float, return 0 on failure."""
    try:
        return float(str(val or "0").replace(",", ""))
    except (TypeError, ValueError):
        return 0
