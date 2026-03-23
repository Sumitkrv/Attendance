import json
import urllib.request

BASE = "http://127.0.0.1:5001"


def req(path, method="GET", payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=20) as response:
        data = json.loads(response.read().decode("utf-8") or "{}")
        return int(response.status), data


_, admin = req("/admin/login", method="POST", payload={"username": "admin", "password": "admin123"})
admin_token = admin["token"]

payload = {
    "enable_liveness": False,
    "scan_require_blink": False,
    "scan_min_face_area_ratio": 0.005,
    "scan_edge_margin_ratio": 0.0,
    "scan_face_upsample_times": 2,
    "scan_expected_tolerance": 0.62,
    "scan_expected_margin": 0.06,
}

status, result = req("/recognition_settings", method="PUT", payload=payload, token=admin_token)
print(json.dumps({"status": status, "settings": result.get("settings")}, indent=2))
