# ==========================================================================
# Item 12: White-Labeling Support
# Allows per-tenant branding customization: logo, colors, company name,
# email templates, favicon, and custom CSS.
# ==========================================================================
import os
from datetime import datetime, timezone
from flask import Blueprint, g, jsonify, request

whitelabel_bp = Blueprint("whitelabel", __name__)


def _get_db():
    from flask import current_app
    return current_app.config.get("_db")


# ==================== Default Branding ====================

DEFAULT_BRANDING = {
    "company_name": "PRHR",
    "tagline": "Smart HR Management System",
    "logo_url": "",
    "favicon_url": "",
    "login_banner_url": "",
    "primary_color": "#4f6ef7",
    "primary_hover": "#3b5ee5",
    "secondary_color": "#6366f1",
    "accent_color": "#22c55e",
    "danger_color": "#ef4444",
    "warning_color": "#f59e0b",
    "background_color": "#f4f7fe",
    "sidebar_color": "#1a1d3a",
    "card_color": "#ffffff",
    "text_primary": "#1e293b",
    "text_secondary": "#64748b",
    "border_radius": "12px",
    "font_family": "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    "custom_css": "",
    "email_from_name": "PRHR",
    "email_from_address": "noreply@prhr.io",
    "email_header_color": "#4f6ef7",
    "email_footer_text": "Powered by PRHR — Face Recognition Attendance System",
    "login_page": {
        "title": "Welcome Back",
        "subtitle": "Sign in to your HR dashboard",
        "show_company_logo": True,
        "background_image": "",
    },
    "dashboard_page": {
        "welcome_message": "Welcome back, {name}!",
        "show_quick_stats": True,
    },
    "powered_by": {
        "show": True,
        "text": "Powered by PRHR",
        "url": "https://prsparkz.com",
    },
}


# ==================== Branding API ====================

@whitelabel_bp.route("/api/branding", methods=["GET"])
def get_branding():
    """
    Get branding configuration for the current tenant.
    Frontend calls this on app init to apply theme.
    """
    db = _get_db()
    tenant_id = getattr(g, "tenant_id", "default") if hasattr(g, "tenant_id") else "default"

    if db:
        branding = db.branding.find_one({"tenant_id": tenant_id})
        if branding:
            branding["_id"] = str(branding.get("_id", ""))
            return jsonify(branding)

    return jsonify({**DEFAULT_BRANDING, "tenant_id": tenant_id})


@whitelabel_bp.route("/api/branding", methods=["PUT"])
def update_branding():
    """Update branding configuration."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    tenant_id = getattr(g, "tenant_id", "default") if hasattr(g, "tenant_id") else "default"
    payload = request.get_json(silent=True) or {}

    # Merge with defaults
    branding = {**DEFAULT_BRANDING}
    for key in DEFAULT_BRANDING:
        if key in payload:
            branding[key] = payload[key]

    branding["tenant_id"] = tenant_id
    branding["updated_at"] = datetime.now(timezone.utc)

    db.branding.update_one(
        {"tenant_id": tenant_id},
        {"$set": branding},
        upsert=True,
    )

    return jsonify({"message": "Branding updated", "branding": branding})


@whitelabel_bp.route("/api/branding/css", methods=["GET"])
def get_branding_css():
    """
    Generate CSS custom properties from branding config.
    Frontend injects this as a <style> tag to override defaults.
    """
    db = _get_db()
    tenant_id = getattr(g, "tenant_id", "default") if hasattr(g, "tenant_id") else "default"

    branding = DEFAULT_BRANDING.copy()
    if db:
        custom = db.branding.find_one({"tenant_id": tenant_id})
        if custom:
            branding.update({k: v for k, v in custom.items() if k in DEFAULT_BRANDING})

    css_vars = f""":root {{
  --color-primary: {branding['primary_color']};
  --color-primary-hover: {branding['primary_hover']};
  --color-secondary: {branding['secondary_color']};
  --color-accent: {branding['accent_color']};
  --color-danger: {branding['danger_color']};
  --color-warning: {branding['warning_color']};
  --bg-primary: {branding['background_color']};
  --bg-sidebar: {branding['sidebar_color']};
  --bg-card: {branding['card_color']};
  --text-primary: {branding['text_primary']};
  --text-secondary: {branding['text_secondary']};
  --radius-lg: {branding['border_radius']};
  --font-family: {branding['font_family']};
}}"""

    custom_css = branding.get("custom_css", "")
    if custom_css:
        css_vars += f"\n\n/* Custom CSS */\n{custom_css}"

    from flask import Response
    return Response(css_vars, mimetype="text/css", headers={
        "Cache-Control": "public, max-age=3600",
    })


@whitelabel_bp.route("/api/branding/reset", methods=["POST"])
def reset_branding():
    """Reset branding to defaults."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    tenant_id = getattr(g, "tenant_id", "default") if hasattr(g, "tenant_id") else "default"
    db.branding.delete_one({"tenant_id": tenant_id})
    return jsonify({"message": "Branding reset to defaults"})


# ==================== Logo Upload ====================

@whitelabel_bp.route("/api/branding/logo", methods=["POST"])
def upload_logo():
    """Upload a company logo."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    if "file" not in request.files:
        return jsonify({"message": "No file uploaded"}), 400

    file = request.files["file"]
    filename = (file.filename or "").lower()

    if not any(filename.endswith(ext) for ext in [".png", ".jpg", ".jpeg", ".svg", ".webp"]):
        return jsonify({"message": "Invalid file format. Use PNG, JPG, SVG, or WebP."}), 400

    # In production, upload to Cloudinary/S3
    # For now, save to static directory
    import uuid
    safe_name = f"logo_{uuid.uuid4().hex[:8]}{os.path.splitext(filename)[1]}"
    upload_dir = os.path.join(os.path.dirname(__file__), "..", "..", "static", "branding")
    os.makedirs(upload_dir, exist_ok=True)
    filepath = os.path.join(upload_dir, safe_name)
    file.save(filepath)

    logo_url = f"/static/branding/{safe_name}"
    tenant_id = getattr(g, "tenant_id", "default") if hasattr(g, "tenant_id") else "default"

    db.branding.update_one(
        {"tenant_id": tenant_id},
        {"$set": {"logo_url": logo_url, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )

    return jsonify({"message": "Logo uploaded", "logo_url": logo_url})


# ==================== Email Template Branding ====================

@whitelabel_bp.route("/api/branding/email-template", methods=["GET"])
def get_email_template():
    """Get branded email HTML template for the current tenant."""
    db = _get_db()
    tenant_id = getattr(g, "tenant_id", "default") if hasattr(g, "tenant_id") else "default"

    branding = DEFAULT_BRANDING.copy()
    if db:
        custom = db.branding.find_one({"tenant_id": tenant_id})
        if custom:
            branding.update({k: v for k, v in custom.items() if k in DEFAULT_BRANDING})

    template = f"""<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0; padding:0; font-family:{branding['font_family']}; background:#f4f7fe;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; margin:0 auto;">
    <tr>
      <td style="background:{branding['email_header_color']}; padding:24px; text-align:center;">
        <h1 style="color:#fff; margin:0; font-size:24px;">{branding['company_name']}</h1>
      </td>
    </tr>
    <tr>
      <td style="background:#fff; padding:32px;">
        {{{{content}}}}
      </td>
    </tr>
    <tr>
      <td style="background:#f1f5f9; padding:16px; text-align:center; color:#64748b; font-size:12px;">
        {branding['email_footer_text']}
      </td>
    </tr>
  </table>
</body>
</html>"""

    return jsonify({"template": template})
