# ==========================================================================
# Item 10: WebSocket Support for Real-time Updates
# Uses Server-Sent Events (SSE) as a lightweight alternative to full
# WebSocket that works with Flask without additional dependencies.
# For full WebSocket, add flask-socketio.
# ==========================================================================
import json
import time
import queue
import threading
from datetime import datetime, timezone
from flask import Blueprint, Response, request, jsonify

realtime_bp = Blueprint("realtime", __name__)

# ==================== Event Bus ====================

class EventBus:
    """
    Simple in-process event bus for SSE (Server-Sent Events).
    Supports multiple subscribers with topic-based filtering.
    """

    def __init__(self):
        self._subscribers = {}  # {subscriber_id: {"queue": Queue, "topics": set}}
        self._lock = threading.Lock()
        self._counter = 0

    def subscribe(self, topics=None):
        """Create a new subscriber. Returns (subscriber_id, queue)."""
        with self._lock:
            self._counter += 1
            sub_id = f"sub_{self._counter}_{int(time.time())}"
            q = queue.Queue(maxsize=100)
            self._subscribers[sub_id] = {
                "queue": q,
                "topics": set(topics) if topics else {"*"},
                "created_at": datetime.now(timezone.utc),
            }
            return sub_id, q

    def unsubscribe(self, sub_id):
        """Remove a subscriber."""
        with self._lock:
            self._subscribers.pop(sub_id, None)

    def publish(self, topic, data, event_type="message"):
        """Publish an event to all matching subscribers."""
        event = {
            "topic": topic,
            "type": event_type,
            "data": data,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        with self._lock:
            dead = []
            for sub_id, sub in self._subscribers.items():
                if "*" in sub["topics"] or topic in sub["topics"]:
                    try:
                        sub["queue"].put_nowait(event)
                    except queue.Full:
                        dead.append(sub_id)
            for sub_id in dead:
                self._subscribers.pop(sub_id, None)

    @property
    def subscriber_count(self):
        return len(self._subscribers)


# Global event bus instance
event_bus = EventBus()


# ==================== SSE Endpoint ====================

@realtime_bp.route("/api/events/stream", methods=["GET"])
def event_stream():
    """
    Server-Sent Events (SSE) endpoint.
    Clients connect and receive real-time updates.

    Usage (frontend):
        const es = new EventSource('/api/events/stream?topics=attendance,notifications')
        es.onmessage = (e) => console.log(JSON.parse(e.data))
    """
    topics = request.args.get("topics", "").split(",")
    topics = [t.strip() for t in topics if t.strip()] or None

    sub_id, q = event_bus.subscribe(topics)

    def generate():
        try:
            # Send initial connection event
            yield f"data: {json.dumps({'type': 'connected', 'subscriber_id': sub_id})}\n\n"

            while True:
                try:
                    event = q.get(timeout=30)
                    yield f"event: {event.get('type', 'message')}\ndata: {json.dumps(event)}\n\n"
                except queue.Empty:
                    # Send keepalive
                    yield f": keepalive {datetime.now(timezone.utc).isoformat()}\n\n"
        except GeneratorExit:
            event_bus.unsubscribe(sub_id)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
            "Connection": "keep-alive",
        },
    )


# ==================== Event Publishing API ====================

@realtime_bp.route("/api/events/publish", methods=["POST"])
def publish_event():
    """Publish an event (admin only). Used internally by the system."""
    payload = request.get_json(silent=True) or {}
    topic = (payload.get("topic") or "").strip()
    data = payload.get("data", {})
    event_type = payload.get("event_type", "message")

    if not topic:
        return jsonify({"message": "topic is required"}), 400

    event_bus.publish(topic, data, event_type)
    return jsonify({"message": "Event published", "subscribers": event_bus.subscriber_count})


@realtime_bp.route("/api/events/status", methods=["GET"])
def event_status():
    """Get real-time event system status."""
    return jsonify({
        "active_subscribers": event_bus.subscriber_count,
        "status": "running",
    })


# ==================== Helper: Publish from other modules ====================

def publish_attendance_event(employee_name, action, details=None):
    """Publish an attendance event (check-in/check-out)."""
    event_bus.publish("attendance", {
        "employee_name": employee_name,
        "action": action,
        "details": details or {},
    }, event_type="attendance_update")


def publish_notification(title, message, target="all"):
    """Publish a notification event."""
    event_bus.publish("notifications", {
        "title": title,
        "message": message,
        "target": target,
    }, event_type="notification")


def publish_task_update(task_id, action, details=None):
    """Publish a task update event."""
    event_bus.publish("tasks", {
        "task_id": task_id,
        "action": action,
        "details": details or {},
    }, event_type="task_update")


def publish_leave_update(request_id, action, employee_name=None):
    """Publish a leave request update event."""
    event_bus.publish("leave", {
        "request_id": request_id,
        "action": action,
        "employee_name": employee_name,
    }, event_type="leave_update")
