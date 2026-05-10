# ==========================================================================
# Item 4: Multi-Location Geofence Support
# Allows multiple office locations with individual radius settings.
# Employees can be assigned to specific locations.
# ==========================================================================
from datetime import datetime, timezone
from math import radians, cos, sin, asin, sqrt
from flask import Blueprint, g, jsonify, request
from bson import ObjectId
from bson.errors import InvalidId

multi_geofence_bp = Blueprint("multi_geofence", __name__)


def _get_db():
    from flask import current_app
    return current_app.config.get("_db")


def _haversine(lat1, lng1, lat2, lng2):
    """Calculate distance in meters between two GPS coordinates."""
    R = 6371000  # Earth radius in meters
    lat1, lng1, lat2, lng2 = map(radians, [lat1, lng1, lat2, lng2])
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlng / 2) ** 2
    return R * 2 * asin(sqrt(a))


# ==================== Location CRUD ====================

@multi_geofence_bp.route("/api/locations", methods=["GET"])
def list_locations():
    """List all office locations."""
    db = _get_db()
    if not db:
        return jsonify([])
    locations = list(db.office_locations.find({}).sort("name", 1))
    for loc in locations:
        loc["_id"] = str(loc["_id"])
    return jsonify(locations)


@multi_geofence_bp.route("/api/locations", methods=["POST"])
def create_location():
    """Create a new office location."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    lat = payload.get("latitude")
    lng = payload.get("longitude")
    radius = payload.get("radius_meters", 200)

    if not name or lat is None or lng is None:
        return jsonify({"message": "name, latitude, and longitude are required"}), 400

    doc = {
        "name": name,
        "address": (payload.get("address") or "").strip(),
        "latitude": float(lat),
        "longitude": float(lng),
        "radius_meters": int(radius),
        "timezone": payload.get("timezone", "Asia/Kolkata"),
        "is_active": True,
        "working_hours": {
            "start": payload.get("working_hours_start", "09:00"),
            "end": payload.get("working_hours_end", "18:00"),
        },
        "allowed_departments": payload.get("allowed_departments", []),
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    result = db.office_locations.insert_one(doc)
    doc["_id"] = str(result.inserted_id)
    return jsonify({"message": "Location created", "location": doc})


@multi_geofence_bp.route("/api/locations/<location_id>", methods=["PUT"])
def update_location(location_id):
    """Update an office location."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    try:
        oid = ObjectId(location_id)
    except (InvalidId, Exception):
        return jsonify({"message": "Invalid location ID"}), 400

    payload = request.get_json(silent=True) or {}
    update_fields = {"updated_at": datetime.now(timezone.utc)}

    for field in ["name", "address", "latitude", "longitude", "radius_meters",
                  "timezone", "is_active", "working_hours", "allowed_departments"]:
        if field in payload:
            update_fields[field] = payload[field]

    db.office_locations.update_one({"_id": oid}, {"$set": update_fields})
    return jsonify({"message": "Location updated"})


@multi_geofence_bp.route("/api/locations/<location_id>", methods=["DELETE"])
def delete_location(location_id):
    """Delete an office location."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    try:
        oid = ObjectId(location_id)
    except (InvalidId, Exception):
        return jsonify({"message": "Invalid location ID"}), 400

    result = db.office_locations.delete_one({"_id": oid})
    if result.deleted_count == 0:
        return jsonify({"message": "Location not found"}), 404
    return jsonify({"message": "Location deleted"})


# ==================== Multi-Location Validation ====================

@multi_geofence_bp.route("/api/locations/validate", methods=["POST"])
def validate_location():
    """
    Validate if coordinates are within ANY active office location.
    Used by the attendance scanner to check geofence compliance.
    """
    db = _get_db()
    if not db:
        return jsonify({"ok": True, "message": "No location validation (DB unavailable)"})

    payload = request.get_json(silent=True) or {}
    user_lat = payload.get("latitude")
    user_lng = payload.get("longitude")
    employee_id = payload.get("employee_id")

    if user_lat is None or user_lng is None:
        return jsonify({"ok": False, "message": "latitude and longitude are required"}), 400

    user_lat = float(user_lat)
    user_lng = float(user_lng)

    # Get all active locations
    locations = list(db.office_locations.find({"is_active": True}))
    if not locations:
        return jsonify({"ok": True, "message": "No locations configured, attendance allowed"})

    # Check if employee has a specific assigned location
    if employee_id:
        employee = db.employees.find_one({"_id": ObjectId(employee_id)} if ObjectId.is_valid(str(employee_id)) else {"login_id": employee_id})
        assigned_location_id = employee.get("assigned_location_id") if employee else None
        if assigned_location_id:
            # Only check assigned location
            loc = db.office_locations.find_one({"_id": ObjectId(assigned_location_id), "is_active": True})
            if loc:
                locations = [loc]

    # Check proximity to any active location
    closest = None
    closest_distance = float("inf")

    for loc in locations:
        distance = _haversine(user_lat, user_lng, loc["latitude"], loc["longitude"])
        if distance < closest_distance:
            closest_distance = distance
            closest = loc

        if distance <= loc.get("radius_meters", 200):
            return jsonify({
                "ok": True,
                "location_id": str(loc["_id"]),
                "location_name": loc["name"],
                "distance_meters": round(distance, 1),
                "radius_meters": loc["radius_meters"],
            })

    # Not within any location
    return jsonify({
        "ok": False,
        "message": "Not within any office location",
        "closest_location": closest["name"] if closest else None,
        "closest_distance_meters": round(closest_distance, 1) if closest else None,
    }), 403


# ==================== Employee Location Assignment ====================

@multi_geofence_bp.route("/api/employees/<employee_id>/location", methods=["PUT"])
def assign_employee_location(employee_id):
    """Assign an employee to a specific office location."""
    db = _get_db()
    if not db:
        return jsonify({"message": "Database not available"}), 503

    payload = request.get_json(silent=True) or {}
    location_id = payload.get("location_id")

    if location_id:
        loc = db.office_locations.find_one({"_id": ObjectId(location_id)})
        if not loc:
            return jsonify({"message": "Location not found"}), 404

    try:
        oid = ObjectId(employee_id)
    except (InvalidId, Exception):
        return jsonify({"message": "Invalid employee ID"}), 400

    db.employees.update_one(
        {"_id": oid},
        {"$set": {
            "assigned_location_id": location_id,
            "updated_at": datetime.now(timezone.utc),
        }}
    )
    return jsonify({"message": "Employee location updated"})
