from collections import defaultdict, deque

import cv2
import numpy as np


def _distance(p1, p2) -> float:
    a = np.array([p1[0], p1[1]], dtype=np.float32)
    b = np.array([p2[0], p2[1]], dtype=np.float32)
    return float(np.linalg.norm(a - b))


def _eye_aspect_ratio(eye_points) -> float:
    # EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
    v1 = _distance(eye_points[1], eye_points[5])
    v2 = _distance(eye_points[2], eye_points[4])
    h = _distance(eye_points[0], eye_points[3])
    return 0.0 if h == 0 else (v1 + v2) / (2.0 * h)


class LivenessAndSpoofGuard:
    """Simple passive checks: blink + motion + texture to reduce spoofing risk."""

    def __init__(
        self,
        blink_consec_frames: int = 2,
        movement_min_pixels: int = 3,
        movement_min_frames: int = 4,
        movement_min_span_pixels: int = 8,
        min_laplacian_var: float = 55.0,
    ):
        self.blink_consec_frames = blink_consec_frames
        self.movement_min_pixels = movement_min_pixels
        self.movement_min_frames = max(2, int(movement_min_frames))
        self.movement_min_span_pixels = max(int(movement_min_pixels), int(movement_min_span_pixels))
        self.min_laplacian_var = min_laplacian_var

        self._ear_low_streak = defaultdict(int)
        self._blink_seen = defaultdict(bool)
        self._blink_count = defaultdict(int)
        self._center_history = defaultdict(lambda: deque(maxlen=12))
        self._ear_history = defaultdict(lambda: deque(maxlen=25))

    def reset_person(self, person_key: str):
        self._ear_low_streak.pop(person_key, None)
        self._blink_seen.pop(person_key, None)
        self._blink_count.pop(person_key, None)
        self._center_history.pop(person_key, None)
        self._ear_history.pop(person_key, None)

    def has_blink(self, person_key: str) -> bool:
        return bool(self._blink_seen.get(person_key, False))

    def _laplacian_variance(self, face_roi_bgr) -> float:
        gray = cv2.cvtColor(face_roi_bgr, cv2.COLOR_BGR2GRAY)
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())

    def _movement_meta(self, person_key: str) -> dict:
        points = self._center_history[person_key]
        if len(points) < self.movement_min_frames:
            return {
                "ok": False,
                "x_ok": False,
                "y_ok": False,
                "span_x": 0,
                "span_y": 0,
                "delta_x": 0,
                "delta_y": 0,
                "samples": len(points),
            }

        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        first_x, first_y = points[0]
        last_x, last_y = points[-1]

        span_x = int(max(xs) - min(xs))
        span_y = int(max(ys) - min(ys))
        delta_x = int(abs(last_x - first_x))
        delta_y = int(abs(last_y - first_y))

        x_ok = span_x >= self.movement_min_span_pixels and delta_x >= self.movement_min_pixels
        y_ok = span_y >= self.movement_min_span_pixels and delta_y >= self.movement_min_pixels

        return {
            "ok": bool(x_ok or y_ok),
            "x_ok": bool(x_ok),
            "y_ok": bool(y_ok),
            "span_x": span_x,
            "span_y": span_y,
            "delta_x": delta_x,
            "delta_y": delta_y,
            "samples": len(points),
        }

    def _blink_ok(self, person_key: str, landmarks: dict) -> tuple[bool, float, float]:
        left = landmarks.get("left_eye")
        right = landmarks.get("right_eye")
        if not left or not right or len(left) < 6 or len(right) < 6:
            return bool(self._blink_seen.get(person_key, False)), 0.0, 0.21

        ear = (_eye_aspect_ratio(left) + _eye_aspect_ratio(right)) / 2.0
        self._ear_history[person_key].append(float(ear))

        # Adaptive threshold improves robustness for glasses and different eye shapes.
        # Keep hard bounds so threshold does not drift to insecure values.
        baseline_ear = float(np.median(self._ear_history[person_key])) if self._ear_history[person_key] else 0.26
        dynamic_threshold = max(0.14, min(0.24, baseline_ear * 0.78))

        if ear < dynamic_threshold:
            self._ear_low_streak[person_key] += 1
        else:
            if self._ear_low_streak[person_key] >= self.blink_consec_frames:
                self._blink_seen[person_key] = True
                self._blink_count[person_key] += 1
            self._ear_low_streak[person_key] = 0

        return self._blink_seen[person_key], float(ear), float(dynamic_threshold)

    def verify(self, person_key: str, face_roi_bgr, landmarks: dict, scaled_location) -> tuple[bool, dict]:
        top, right, bottom, left = scaled_location
        cx = int((left + right) / 2)
        cy = int((top + bottom) / 2)
        self._center_history[person_key].append((cx, cy))

        texture_score = self._laplacian_variance(face_roi_bgr)
        texture_ok = texture_score >= self.min_laplacian_var
        blink_ok, ear, ear_threshold = self._blink_ok(person_key, landmarks)
        movement = self._movement_meta(person_key)
        movement_ok = bool(movement.get("ok"))

        is_live = bool(texture_ok and (blink_ok or movement_ok))
        meta = {
            "texture_ok": texture_ok,
            "blink_ok": blink_ok,
            "blink_count": int(self._blink_count[person_key]),
            "movement_ok": movement_ok,
            "movement_x_ok": bool(movement.get("x_ok")),
            "movement_y_ok": bool(movement.get("y_ok")),
            "movement_span_x": int(movement.get("span_x") or 0),
            "movement_span_y": int(movement.get("span_y") or 0),
            "movement_delta_x": int(movement.get("delta_x") or 0),
            "movement_delta_y": int(movement.get("delta_y") or 0),
            "movement_samples": int(movement.get("samples") or 0),
            "texture_score": round(texture_score, 2),
            "ear": round(float(ear), 4),
            "ear_threshold": round(float(ear_threshold), 4),
        }
        return is_live, meta
