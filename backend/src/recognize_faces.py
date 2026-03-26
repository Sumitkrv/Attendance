import pickle
import threading
import os
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

_IST = timezone(timedelta(hours=5, minutes=30))

import cv2
import face_recognition
import numpy as np

from src.liveness import LivenessAndSpoofGuard
from src.utils.helpers import env_float, env_int


class FaceRecognizer:
    """Real-time webcam recognizer that marks attendance on recognized faces."""

    def __init__(self, attendance_manager, model_path: str):
        self.attendance_manager = attendance_manager
        self.model_path = Path(model_path)
        self.camera_index = env_int("CAMERA_INDEX", 0)
        self.tolerance = env_float("RECOGNITION_TOLERANCE", 0.5)
        self.resize_scale = env_float("FRAME_RESIZE_SCALE", 0.25)
        self.process_every_n_frames = max(1, env_int("PROCESS_EVERY_N_FRAMES", 2))
        self.face_upsample_times = max(0, env_int("FACE_UPSAMPLE_TIMES", 0))
        self.face_detection_model = "hog"
        preview_raw = str(os.getenv("DISPLAY_PREVIEW", "false")).lower()
        self.display_preview = preview_raw in {"1", "true", "yes", "on"}

        enable_liveness_raw = str(os.getenv("ENABLE_LIVENESS", "true")).lower()
        self.enable_liveness = enable_liveness_raw in {"1", "true", "yes", "on"}
        scan_require_blink_raw = str(os.getenv("SCAN_REQUIRE_BLINK", "true")).lower()
        self.scan_require_blink = scan_require_blink_raw in {"1", "true", "yes", "on"}
        self.scan_required_blink_count = max(1, env_int("SCAN_REQUIRED_BLINK_COUNT", 1))
        self.scan_resize_width = max(320, env_int("SCAN_RESIZE_WIDTH", 640))
        self.scan_face_upsample_times = max(0, env_int("SCAN_FACE_UPSAMPLE_TIMES", 0))
        scan_model = str(os.getenv("SCAN_FACE_DETECTION_MODEL", "hog")).strip().lower()
        self.scan_face_detection_model = "cnn" if scan_model == "cnn" else "hog"
        self.scan_min_face_area_ratio = max(0.005, env_float("SCAN_MIN_FACE_AREA_RATIO", 0.03))
        self.scan_edge_margin_ratio = max(0.0, env_float("SCAN_EDGE_MARGIN_RATIO", 0.02))
        self.scan_expected_tolerance = env_float("SCAN_EXPECTED_TOLERANCE", 0.63)
        self.scan_expected_margin = env_float("SCAN_EXPECTED_MARGIN", 0.06)
        self.scan_min_duration_seconds = max(0.0, min(2.0, env_float("SCAN_MIN_DURATION_SECONDS", 0.35)))
        self.liveness_movement_min_pixels_floor = max(1, env_int("LIVENESS_MOVEMENT_MIN_PIXELS", 3))
        self.liveness_movement_min_frames = max(2, env_int("LIVENESS_MOVEMENT_MIN_FRAMES", 4))
        self.liveness_movement_min_span_pixels = max(
            2,
            env_int(
                "LIVENESS_MOVEMENT_MIN_SPAN_PIXELS",
                max(8, self.liveness_movement_min_pixels_floor * 2),
            ),
        )
        self.guard = LivenessAndSpoofGuard(
            blink_consec_frames=max(1, env_int("LIVENESS_BLINK_CONSEC_FRAMES", 1)),
            movement_min_pixels=self.liveness_movement_min_pixels_floor,
            movement_min_frames=self.liveness_movement_min_frames,
            movement_min_span_pixels=self.liveness_movement_min_span_pixels,
            min_laplacian_var=env_float("LIVENESS_MIN_LAPLACIAN_VAR", 55.0),
        )

        self._known_encodings = []
        self._known_names = []
        self._known_name_keys = []
        self._encodings_by_name = {}
        self._model_mtime_ns = None
        self._next_model_mtime_check_at = 0.0
        self._running = False
        self._thread = None
        self._frame_count = 0
        self._events = deque(maxlen=100)
        self._last_event = {
            "type": "idle",
            "status": "idle",
            "message": "Camera idle",
            "time": datetime.now(_IST).isoformat(),
        }

    def _ensure_model_loaded(self):
        if len(self._known_encodings) == 0:
            self.load_model()
            return

        now_ts = time.time()
        if now_ts < float(self._next_model_mtime_check_at):
            return
        self._next_model_mtime_check_at = now_ts + 3.0

        try:
            mtime_ns = self.model_path.stat().st_mtime_ns
        except Exception:
            mtime_ns = None

        if mtime_ns is not None and self._model_mtime_ns is not None and mtime_ns > self._model_mtime_ns:
            self.load_model()

    @property
    def last_event(self) -> dict:
        return dict(self._last_event)

    @property
    def events(self) -> list:
        return list(self._events)

    def _set_event(
        self,
        event_type: str,
        message: str,
        status: Optional[str] = None,
        name: Optional[str] = None,
    ):
        event = {
            "type": event_type,
            "status": status or event_type,
            "message": message,
            "time": datetime.now(_IST).isoformat(),
            "employee_name": name,
        }
        self._last_event = event
        self._events.appendleft(event)

    def get_settings(self) -> dict:
        return {
            "tolerance": self.tolerance,
            "resize_scale": self.resize_scale,
            "process_every_n_frames": self.process_every_n_frames,
            "face_upsample_times": self.face_upsample_times,
            "enable_liveness": self.enable_liveness,
            "scan_require_blink": self.scan_require_blink,
            "scan_required_blink_count": self.scan_required_blink_count,
            "scan_resize_width": self.scan_resize_width,
            "scan_face_upsample_times": self.scan_face_upsample_times,
            "scan_face_detection_model": self.scan_face_detection_model,
            "scan_min_face_area_ratio": self.scan_min_face_area_ratio,
            "scan_edge_margin_ratio": self.scan_edge_margin_ratio,
            "scan_expected_tolerance": self.scan_expected_tolerance,
            "scan_expected_margin": self.scan_expected_margin,
            "scan_min_duration_seconds": self.scan_min_duration_seconds,
            "blink_consec_frames": self.guard.blink_consec_frames,
            "movement_min_pixels": self.guard.movement_min_pixels,
            "movement_min_frames": self.guard.movement_min_frames,
            "movement_min_span_pixels": self.guard.movement_min_span_pixels,
            "min_laplacian_var": self.guard.min_laplacian_var,
        }

    def apply_settings(self, payload: dict) -> dict:
        if "tolerance" in payload:
            self.tolerance = float(payload["tolerance"])
        if "resize_scale" in payload:
            self.resize_scale = max(0.1, float(payload["resize_scale"]))
        if "process_every_n_frames" in payload:
            self.process_every_n_frames = max(1, int(payload["process_every_n_frames"]))
        if "face_upsample_times" in payload:
            self.face_upsample_times = max(0, int(payload["face_upsample_times"]))
        if "enable_liveness" in payload:
            self.enable_liveness = bool(payload["enable_liveness"])
        if "scan_require_blink" in payload:
            # Blink is mandatory for attendance scan.
            self.scan_require_blink = True
        if "scan_required_blink_count" in payload:
            self.scan_required_blink_count = max(1, int(payload["scan_required_blink_count"]))
        if "scan_resize_width" in payload:
            self.scan_resize_width = max(320, int(payload["scan_resize_width"]))
        if "scan_face_upsample_times" in payload:
            self.scan_face_upsample_times = max(0, int(payload["scan_face_upsample_times"]))
        if "scan_face_detection_model" in payload:
            model_value = str(payload["scan_face_detection_model"] or "hog").strip().lower()
            self.scan_face_detection_model = "cnn" if model_value == "cnn" else "hog"
        if "scan_min_face_area_ratio" in payload:
            self.scan_min_face_area_ratio = max(0.005, float(payload["scan_min_face_area_ratio"]))
        if "scan_edge_margin_ratio" in payload:
            self.scan_edge_margin_ratio = max(0.0, float(payload["scan_edge_margin_ratio"]))
        if "scan_expected_tolerance" in payload:
            self.scan_expected_tolerance = float(payload["scan_expected_tolerance"])
        if "scan_expected_margin" in payload:
            self.scan_expected_margin = float(payload["scan_expected_margin"])
        if "scan_min_duration_seconds" in payload:
            self.scan_min_duration_seconds = max(0.0, min(2.0, float(payload["scan_min_duration_seconds"])))
        if "blink_consec_frames" in payload:
            self.guard.blink_consec_frames = max(1, int(payload["blink_consec_frames"]))
        if "movement_min_pixels" in payload:
            self.guard.movement_min_pixels = max(self.liveness_movement_min_pixels_floor, int(payload["movement_min_pixels"]))
        if "movement_min_frames" in payload:
            self.guard.movement_min_frames = max(self.liveness_movement_min_frames, int(payload["movement_min_frames"]))
        if "movement_min_span_pixels" in payload:
            self.guard.movement_min_span_pixels = max(self.liveness_movement_min_span_pixels, int(payload["movement_min_span_pixels"]))
        if "min_laplacian_var" in payload:
            self.guard.min_laplacian_var = float(payload["min_laplacian_var"])

        self._set_event("info", "Recognition settings updated", status="settings_updated")
        return self.get_settings()

    def load_model(self):
        if not self.model_path.exists():
            raise FileNotFoundError(
                f"Model file not found at {self.model_path}. Train model first using /train_model"
            )

        with open(self.model_path, "rb") as f:
            data = pickle.load(f)

        self._known_encodings = data.get("encodings", [])
        self._known_names = data.get("names", [])
        self.face_detection_model = data.get("face_detection_model", "hog")

        if not self._known_encodings:
            raise ValueError("Model has no encodings. Retrain with valid dataset images.")

        self._known_encodings = np.array(self._known_encodings)
        self._known_name_keys = [str(x).strip().lower() for x in self._known_names]
        grouped = {}
        for idx, person_name in enumerate(self._known_names):
            key = str(person_name).strip().lower()
            grouped.setdefault(key, []).append(self._known_encodings[idx])
        self._encodings_by_name = {
            key: np.array(items)
            for key, items in grouped.items()
            if items
        }
        try:
            self._model_mtime_ns = self.model_path.stat().st_mtime_ns
        except Exception:
            self._model_mtime_ns = None

    @property
    def is_running(self) -> bool:
        return self._running

    def start(self) -> dict:
        if self._running:
            return {"message": "Camera is already running"}

        self.load_model()
        self._running = True
        self._set_event("info", "Camera started")
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return {"message": "Camera started"}

    def stop(self) -> dict:
        if not self._running:
            return {"message": "Camera is not running"}

        self._running = False
        self._set_event("info", "Camera stopped")
        return {"message": "Camera stopped"}

    def _run(self):
        cap = cv2.VideoCapture(self.camera_index)
        if not cap.isOpened():
            self._running = False
            return

        try:
            while self._running:
                ret, frame = cap.read()
                if not ret:
                    continue

                self._frame_count += 1
                if self._frame_count % self.process_every_n_frames != 0:
                    if self.display_preview:
                        cv2.imshow("Face Attendance Camera", frame)
                        if cv2.waitKey(1) & 0xFF == ord("q"):
                            self._running = False
                    continue

                small_frame = cv2.resize(frame, (0, 0), fx=self.resize_scale, fy=self.resize_scale)
                rgb_small_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)

                locations = face_recognition.face_locations(
                    rgb_small_frame,
                    number_of_times_to_upsample=self.face_upsample_times,
                    model=self.face_detection_model,
                )
                encodings = face_recognition.face_encodings(rgb_small_frame, locations)
                landmarks_list = face_recognition.face_landmarks(rgb_small_frame, locations)
                should_stop = False

                for idx, face_encoding in enumerate(encodings):
                    face_distances = face_recognition.face_distance(
                        self._known_encodings, face_encoding
                    )

                    name = "Unknown"
                    if len(face_distances) > 0:
                        best_match_index = face_distances.argmin()
                        if face_distances[best_match_index] <= self.tolerance:
                            name = self._known_names[best_match_index]

                    if name == "Unknown":
                        self._set_event("error", "Wrong data: face not matched", status="wrong_data")
                        continue

                    top, right, bottom, left = locations[idx]
                    top = max(0, top)
                    left = max(0, left)
                    bottom = max(top + 1, bottom)
                    right = max(left + 1, right)
                    face_roi = small_frame[top:bottom, left:right]

                    is_live = True
                    if self.enable_liveness and face_roi.size > 0:
                        landmarks = landmarks_list[idx] if idx < len(landmarks_list) else {}
                        is_live, _ = self.guard.verify(name, face_roi, landmarks, locations[idx])

                    if not is_live:
                        self._set_event("error", "Wrong data: liveness check failed", status="wrong_data")
                        continue

                    result = self.attendance_manager.mark_attendance(name)
                    status = result.get("status", "ok")
                    if status in {"checked_in", "checked_out", "already_recorded"}:
                        self._set_event(
                            "success",
                            f"{name}: {status.replace('_', ' ')}. Camera auto-stopped",
                            status=status,
                            name=name,
                        )
                        should_stop = True
                    else:
                        self._set_event(
                            "info",
                            result.get("message", "Attendance updated"),
                            status=status,
                            name=name,
                        )

                if should_stop:
                    self._running = False

                # show local preview window (optional)
                if self.display_preview:
                    cv2.imshow("Face Attendance Camera", frame)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        self._running = False

        finally:
            cap.release()
            if self.display_preview:
                cv2.destroyAllWindows()
            self._running = False

    def _head_turn_offset(self, landmarks: dict, face_location) -> float:
        left_eye = landmarks.get("left_eye") or []
        right_eye = landmarks.get("right_eye") or []
        nose_tip = landmarks.get("nose_tip") or landmarks.get("nose_bridge") or []
        if not left_eye or not right_eye or not nose_tip:
            return 0.0

        eye_center_x = (sum(p[0] for p in left_eye) + sum(p[0] for p in right_eye)) / (len(left_eye) + len(right_eye))
        nose_center_x = sum(p[0] for p in nose_tip) / len(nose_tip)

        top, right, bottom, left = face_location
        face_width = max(1.0, float(right - left))
        return float((nose_center_x - eye_center_x) / face_width)

    def _face_alignment_guidance(self) -> str:
        return "Come closer to camera or properly align your face."

    def scan_frame(self, frame_bgr, expected_name: Optional[str] = None, challenge_action: Optional[str] = None) -> dict:
        """Recognize one frame and mark attendance for user-panel scanning."""
        scan_start = time.time()
        try:
            self._ensure_model_loaded()
        except Exception:
            self._set_event("error", "No registered users found", status="wrong_data")
            return {"status": "wrong_data", "message": "No registered users found"}

        if len(self._known_encodings) == 0:
            self._set_event("error", "No registered users found", status="wrong_data")
            return {"status": "wrong_data", "message": "No registered users found"}

        if frame_bgr is None or frame_bgr.size == 0:
            self._set_event("error", "Wrong data: invalid image", status="wrong_data")
            return {"status": "wrong_data", "message": "Wrong data: invalid image"}

        frame_for_scan = frame_bgr
        frame_h, frame_w = frame_bgr.shape[:2]
        if frame_w > self.scan_resize_width:
            scale = float(self.scan_resize_width) / float(max(1, frame_w))
            target_h = max(1, int(frame_h * scale))
            frame_for_scan = cv2.resize(
                frame_bgr,
                (self.scan_resize_width, target_h),
                interpolation=cv2.INTER_AREA,
            )

        rgb = cv2.cvtColor(frame_for_scan, cv2.COLOR_BGR2RGB)

        # Fast multi-pass detection: avoid redundant heavy passes.
        first_upsample = max(0, int(self.scan_face_upsample_times))
        locations = face_recognition.face_locations(
            rgb,
            number_of_times_to_upsample=first_upsample,
            model=self.scan_face_detection_model,
        )
        second_upsample = max(1, first_upsample)
        should_try_fallback = (
            not locations
            and (second_upsample != first_upsample)
        )
        if should_try_fallback:
            locations = face_recognition.face_locations(
                rgb,
                number_of_times_to_upsample=second_upsample,
                model=self.scan_face_detection_model,
            )

        if not locations:
            guidance = self._face_alignment_guidance()
            self._set_event("error", guidance, status="wrong_data")
            return {"status": "wrong_data", "message": guidance}

        # Use the largest detected face (closest to camera).
        locations = sorted(locations, key=lambda loc: (loc[2] - loc[0]) * (loc[1] - loc[3]), reverse=True)
        best_location = locations[0]
        top, right, bottom, left = best_location
        face_w = max(1, int(right - left))
        face_h = max(1, int(bottom - top))
        frame_area = float(max(1, frame_for_scan.shape[0] * frame_for_scan.shape[1]))
        face_area_ratio = float(face_w * face_h) / frame_area
        if face_area_ratio < float(self.scan_min_face_area_ratio):
            guidance = self._face_alignment_guidance()
            self._set_event("error", guidance, status="wrong_data")
            return {"status": "wrong_data", "message": guidance}

        margin_x = int(frame_for_scan.shape[1] * float(self.scan_edge_margin_ratio))
        margin_y = int(frame_for_scan.shape[0] * float(self.scan_edge_margin_ratio))
        touching_edge = (
            left <= margin_x
            or top <= margin_y
            or right >= (frame_for_scan.shape[1] - margin_x)
            or bottom >= (frame_for_scan.shape[0] - margin_y)
        )
        if touching_edge:
            guidance = self._face_alignment_guidance()
            self._set_event("error", guidance, status="wrong_data")
            return {"status": "wrong_data", "message": guidance}

        encodings = face_recognition.face_encodings(rgb, [best_location])
        if not encodings:
            self._set_event("error", "Wrong data: face encoding failed", status="wrong_data")
            return {"status": "wrong_data", "message": "Wrong data: face encoding failed"}

        face_encoding = encodings[0]
        best_match_distance = 1.0
        scan_tolerance = min(0.70, self.tolerance + 0.12)
        name = "Unknown"

        if expected_name:
            expected_key = str(expected_name).strip().lower()
            expected_encodings = self._encodings_by_name.get(expected_key)
            if expected_encodings is None or len(expected_encodings) == 0:
                self._set_event("error", "User not match", status="wrong_data")
                return {
                    "status": "wrong_data",
                    "message": "User not match",
                }

            expected_distances = face_recognition.face_distance(expected_encodings, face_encoding)
            # Use average of top-3 closest distances for more robust matching
            sorted_distances = np.sort(expected_distances)
            top_n = min(3, len(sorted_distances))
            expected_best_distance = float(sorted_distances[:top_n].mean())
            expected_sample_count = int(len(expected_encodings))

            expected_threshold = min(float(self.scan_expected_tolerance), float(scan_tolerance))
            # Users with fewer training images need a wider tolerance cushion.
            if expected_sample_count < 3:
                expected_threshold = min(0.66, expected_threshold + 0.06)
            elif expected_sample_count < 5:
                expected_threshold = min(0.65, expected_threshold + 0.03)

            all_distances = face_recognition.face_distance(self._known_encodings, face_encoding)
            overall_best_distance = float(all_distances.min()) if len(all_distances) else 1.0
            overall_best_index = int(all_distances.argmin()) if len(all_distances) else -1
            overall_best_key = (
                self._known_name_keys[overall_best_index]
                if 0 <= overall_best_index < len(self._known_name_keys)
                else ""
            )
            expected_margin = max(0.0, float(self.scan_expected_margin))

            # Only reject if someone else is a clearly better match (not just marginally closer).
            if (
                overall_best_key
                and overall_best_key != expected_key
                and overall_best_distance < expected_best_distance
                and (expected_best_distance - overall_best_distance) > expected_margin
            ):
                self._set_event("error", "User not match", status="wrong_data")
                return {"status": "wrong_data", "message": "User not match"}

            if expected_best_distance > expected_threshold:
                self._set_event("error", "User not match", status="wrong_data")
                return {"status": "wrong_data", "message": "User not match"}

            best_match_distance = expected_best_distance
            name = expected_name
        else:
            face_distances = face_recognition.face_distance(self._known_encodings, face_encoding)
            if len(face_distances) == 0:
                self._set_event("error", "No registered users found", status="wrong_data")
                return {"status": "wrong_data", "message": "No registered users found"}

            best_match_index = int(face_distances.argmin())
            best_match_distance = float(face_distances[best_match_index])
            name = self._known_names[best_match_index]

            if best_match_distance > scan_tolerance:
                self._set_event("error", "User not match", status="wrong_data")
                return {"status": "wrong_data", "message": "User not match"}

        if self.enable_liveness:
            top, right, bottom, left = best_location
            top = max(0, top)
            left = max(0, left)
            bottom = min(frame_for_scan.shape[0], max(top + 1, bottom))
            right = min(frame_for_scan.shape[1], max(left + 1, right))
            face_roi = frame_for_scan[top:bottom, left:right]
            liveness_key = expected_name or name
            blink_already_seen = False
            try:
                blink_already_seen = bool(self.guard.has_blink(liveness_key))
            except Exception:
                blink_already_seen = False

            need_landmarks = (
                bool(self.scan_require_blink)
                or challenge_action in {"blink", "blink_and_turn", "turn"}
                or not blink_already_seen
            )
            landmarks = {}
            if need_landmarks:
                landmarks_list = face_recognition.face_landmarks(rgb, [best_location])
                landmarks = landmarks_list[0] if landmarks_list else {}

            is_live, meta = self.guard.verify(liveness_key, face_roi, landmarks, best_location)
            head_offset = self._head_turn_offset(landmarks, best_location)
            ear = float(meta.get("ear") or 0.0)
            ear_threshold = float(meta.get("ear_threshold") or 0.21)
            closed_eye_frame = ear > 0 and ear_threshold > 0 and ear <= (ear_threshold * 0.92)
            has_blink = int(meta.get("blink_count") or 0) >= 1 or closed_eye_frame
            has_movement = bool(meta.get("movement_ok")) or abs(head_offset) >= 0.012
            elapsed_sec = float(meta.get("elapsed_sec") or 0.0)

            # Liveness gate:
            # - when blink is required by policy, require both blink + movement.
            # - otherwise allow either blink or movement (with texture check) for faster UX.
            texture_ok = bool(meta.get("texture_ok"))
            liveness_gate_ok = (has_blink and has_movement) if self.scan_require_blink else ((has_blink or has_movement) and texture_ok)
            strong_match_threshold = min(0.56, max(0.44, float(self.scan_expected_tolerance) - 0.04))
            strong_match_pass = bool(expected_name) and (best_match_distance <= strong_match_threshold)
            if not liveness_gate_ok and not strong_match_pass:
                self._set_event("error", "Wrong data: liveness gate not met", status="wrong_data")
                return {
                    "status": "wrong_data",
                    "message": "Unable to verify face. Please retry.",
                }

            if elapsed_sec < float(self.scan_min_duration_seconds):
                self._set_event("error", "Wrong data: hold steady for minimum scan time", status="wrong_data")
                return {
                    "status": "wrong_data",
                    "message": "Align your face properly",
                }

            if self.scan_require_blink:
                strong_match_threshold = min(0.56, max(0.45, self.tolerance + 0.02))
                strong_match_pass = best_match_distance <= strong_match_threshold
                blink_met = int(meta.get("blink_count") or 0) >= int(self.scan_required_blink_count) or closed_eye_frame
                texture_ok = bool(meta.get("texture_ok"))
                strict_live = bool(blink_met and (texture_ok or strong_match_pass))
                if not strict_live:
                    self._set_event("error", "Scanning...", status="wrong_data")
                    return {
                        "status": "wrong_data",
                        "message": "Scanning...",
                    }
            elif not is_live:
                strong_match_threshold = min(0.56, max(0.45, self.tolerance + 0.02))
                strong_match_pass = best_match_distance <= strong_match_threshold
                if not bool(meta.get("texture_ok") and strong_match_pass):
                    self._set_event("error", "Scanning...", status="wrong_data")
                    return {
                        "status": "wrong_data",
                        "message": "Scanning...",
                    }

            if challenge_action == "blink_and_turn":
                challenge_ok = bool(
                    meta.get("texture_ok")
                    and meta.get("blink_ok")
                    and (meta.get("movement_ok") or abs(head_offset) >= 0.012)
                )
                if not challenge_ok:
                    self._set_event("error", "Scanning...", status="wrong_data")
                    return {
                        "status": "wrong_data",
                        "message": "Scanning...",
                    }
            elif challenge_action == "turn":
                if not bool(meta.get("texture_ok") and (meta.get("movement_ok") or abs(head_offset) >= 0.012)):
                    self._set_event("error", "Scanning...", status="wrong_data")
                    return {
                        "status": "wrong_data",
                        "message": "Scanning...",
                    }
            elif challenge_action == "blink":
                if not bool(meta.get("texture_ok") and meta.get("blink_ok")):
                    self._set_event("error", "Scanning...", status="wrong_data")
                    return {
                        "status": "wrong_data",
                        "message": "Scanning...",
                    }

        result = self.attendance_manager.mark_attendance(name)
        status = result.get("status", "info")
        check_in_time = result.get("check_in")
        check_out_time = result.get("check_out")

        if status == "checked_in":
            if check_in_time:
                message = f"Entry marked. Welcome {name}. Check-in: {check_in_time}"
            else:
                message = f"Entry marked. Welcome {name}"
        elif status == "checked_out":
            if check_out_time:
                message = f"Bye bye {name}. Check-out: {check_out_time}"
            else:
                message = f"Bye bye {name}"
        elif status == "already_recorded":
            timing_bits = []
            if check_in_time:
                timing_bits.append(f"in: {check_in_time}")
            if check_out_time:
                timing_bits.append(f"out: {check_out_time}")
            if timing_bits:
                message = f"Attendance is already marked for today, {name} ({', '.join(timing_bits)})"
            else:
                message = f"Attendance is already marked for today, {name}"
        else:
            message = result.get("message", "Attendance updated")

        event_type = "success" if status in {"checked_in", "checked_out", "already_recorded"} else "info"
        self._set_event(event_type, message, status=status, name=name)
        if self.enable_liveness:
            try:
                self.guard.reset_person(expected_name or name)
            except Exception:
                pass
        scan_ms = round((time.time() - scan_start) * 1000, 1)
        return {
            "status": status,
            "employee_name": name,
            "message": message,
            "date": result.get("date"),
            "check_in": result.get("check_in"),
            "check_out": result.get("check_out"),
            "check_in_at": result.get("check_in_at"),
            "check_out_at": result.get("check_out_at"),
            "manual_entry": bool(result.get("manual_entry")),
            "match_distance": round(best_match_distance, 4),
            "scan_time_ms": scan_ms,
        }
