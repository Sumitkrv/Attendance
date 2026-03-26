from typing import Any, Dict


def success_response(message: str, data: Dict[str, Any] | None = None):
    return {"success": True, "message": message, "data": data or {}}
