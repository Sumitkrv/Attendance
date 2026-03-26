from math import atan2, cos, radians, sin, sqrt

from app.core.config import settings


def _haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    earth_radius = 6_371_000
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)

    a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return earth_radius * c


def is_within_allowed_radius(user_lat: float, user_lon: float) -> bool:
    distance = _haversine_meters(user_lat, user_lon, settings.OFFICE_LAT, settings.OFFICE_LON)
    return distance <= settings.OFFICE_RADIUS_METERS
