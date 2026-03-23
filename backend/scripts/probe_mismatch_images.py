import json
import mimetypes
import pathlib
import urllib.error
import urllib.request
import uuid

BASE = "http://127.0.0.1:5001"
LOGIN_ID = "ver"
PASSWORD = "VermaFinalA123!"
DATASET_DIR = pathlib.Path(__file__).resolve().parents[2] / "persistent" / "dataset" / "sumit"


def req(path, method="GET", payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=20) as response:
        return int(response.status), json.loads(response.read().decode("utf-8") or "{}")


def multipart(path, image_path, fields, token):
    boundary = "----fa" + uuid.uuid4().hex
    parts = []

    def add_line(line):
        parts.append(line.encode("utf-8"))
        parts.append(b"\r\n")

    for key, value in fields.items():
        add_line(f"--{boundary}")
        add_line(f'Content-Disposition: form-data; name="{key}"')
        add_line("")
        add_line(str(value))

    ctype = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
    add_line(f"--{boundary}")
    add_line(f'Content-Disposition: form-data; name="image"; filename="{image_path.name}"')
    add_line(f"Content-Type: {ctype}")
    add_line("")
    parts.append(image_path.read_bytes())
    parts.append(b"\r\n")
    add_line(f"--{boundary}--")

    body = b"".join(parts)
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Authorization": f"Bearer {token}",
    }
    request = urllib.request.Request(BASE + path, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            return int(response.status), json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        return int(exc.code), json.loads(exc.read().decode("utf-8") or "{}")


_, admin = req("/admin/login", method="POST", payload={"username": "admin", "password": "admin123"})
admin_token = admin["token"]

# keep geofence on known office location
_, geo = req("/geofence_settings", token=admin_token)
lat = geo.get("office_lat")
lng = geo.get("office_lng")
rad = geo.get("office_radius_meters") or 500
if lat is None or lng is None:
    lat, lng = 28.502756, 77.230419

req(
    "/geofence_settings",
    method="PUT",
    payload={"enabled": True, "office_lat": lat, "office_lng": lng, "office_radius_meters": rad},
    token=admin_token,
)

req(
    "/recognition_settings",
    method="PUT",
    payload={"enable_liveness": False, "scan_require_blink": False},
    token=admin_token,
)

_, user_login = req("/user/login", method="POST", payload={"login_id": LOGIN_ID, "password": PASSWORD})
user_token = user_login.get("token")

results = []
for img in sorted(DATASET_DIR.glob("*.jpg")):
    code, body = multipart(
        "/scan_attendance",
        img,
        {"lat": str(lat), "lng": str(lng), "accuracy": "5"},
        user_token,
    )
    results.append({"file": img.name, "status_code": code, "status": body.get("status"), "message": body.get("message")})

print(json.dumps(results, indent=2))
