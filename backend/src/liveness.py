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
        min_laplacian_var: float = 55.0,
    ):
        self.blink_consec_frames = blink_consec_frames
        self.movement_min_pixels = movement_min_pixels
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

    def _movement_ok(self, person_key: str) -> bool:
        points = self._center_history[person_key]
        if len(points) < 2:
            return False

        x0, y0 = points[0]
        moved = any(abs(x - x0) >= self.movement_min_pixels or abs(y - y0) >= self.movement_min_pixels for x, y in points)
        return moved

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
        movement_ok = self._movement_ok(person_key)

        is_live = bool(texture_ok and (blink_ok or movement_ok))
        meta = {
            "texture_ok": texture_ok,
            "blink_ok": blink_ok,
            "blink_count": int(self._blink_count[person_key]),
            "movement_ok": movement_ok,
            "texture_score": round(texture_score, 2),
            "ear": round(float(ear), 4),
            "ear_threshold": round(float(ear_threshold), 4),
        }
        return is_live, meta
