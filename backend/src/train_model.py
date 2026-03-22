import os
import pickle
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Optional

import cv2
import face_recognition

from src.utils.helpers import ensure_dir, env_float, env_int


def _encode_image_task(args):
    (
        image_path,
        employee_name,
        max_width,
        num_jitters,
        encoding_model,
        min_laplacian_var,
        min_brightness,
        min_face_area_ratio,
    ) = args

    image = cv2.imread(str(image_path))
    if image is None:
        return {
            "ok": False,
            "file": str(image_path),
            "employee_name": employee_name,
            "reason": "Unreadable image",
        }

    h, w = image.shape[:2]
    if w > max_width > 0:
        scale = max_width / float(w)
        image = cv2.resize(image, (int(w * scale), int(h * scale)))

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    if blur_score < float(min_laplacian_var):
        return {
            "ok": False,
            "file": str(image_path),
            "employee_name": employee_name,
            "reason": f"Image too blurry (score={round(blur_score, 2)})",
        }

    brightness = float(gray.mean())
    if brightness < float(min_brightness):
        return {
            "ok": False,
            "file": str(image_path),
            "employee_name": employee_name,
            "reason": f"Image too dark (brightness={round(brightness, 2)})",
        }

    rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    locations = face_recognition.face_locations(rgb_image, number_of_times_to_upsample=0, model="hog")

    if len(locations) == 1:
        top, right, bottom, left = locations[0]
        face_area = max(1, bottom - top) * max(1, right - left)
        frame_area = max(1, rgb_image.shape[0] * rgb_image.shape[1])
        face_ratio = float(face_area / frame_area)
        if face_ratio < float(min_face_area_ratio):
            return {
                "ok": False,
                "file": str(image_path),
                "employee_name": employee_name,
                "reason": f"Face too small (ratio={round(face_ratio, 4)})",
            }

    encodings = face_recognition.face_encodings(
        rgb_image,
        known_face_locations=locations,
        num_jitters=max(1, num_jitters),
        model=encoding_model,
    )

    if len(encodings) != 1:
        return {
            "ok": False,
            "file": str(image_path),
            "employee_name": employee_name,
            "reason": "Image must contain exactly one face",
        }

    return {
        "ok": True,
        "file": str(image_path),
        "employee_name": employee_name,
        "encoding": encodings[0],
    }


class ModelTrainer:
    """Builds face encodings from dataset folders and saves them to pickle."""

    def __init__(self, dataset_path: str, model_path: str):
        self.dataset_path = Path(dataset_path)
        self.model_path = Path(model_path)

    def train(self, progress_callback: Optional[Callable[[int, int, str], None]] = None) -> dict:
        if not self.dataset_path.exists():
            raise FileNotFoundError(f"Dataset path not found: {self.dataset_path}")

        known_encodings = []
        known_names = []
        skipped_files = []
        max_width = env_int("TRAIN_IMAGE_MAX_WIDTH", 800)
        num_jitters = env_int("TRAIN_NUM_JITTERS", 1)
        encoding_model = os.getenv("TRAIN_ENCODING_MODEL", "small")
        requested_workers = env_int("TRAIN_MAX_WORKERS", 0)
        min_laplacian_var = env_float("TRAIN_MIN_LAPLACIAN_VAR", 45.0)
        min_brightness = env_float("TRAIN_MIN_BRIGHTNESS", 35.0)
        min_face_area_ratio = env_float("TRAIN_MIN_FACE_AREA_RATIO", 0.02)

        employee_folders = [
            p for p in self.dataset_path.iterdir() if p.is_dir() and not p.name.startswith(".")
        ]

        jobs = []
        for employee_folder in employee_folders:
            employee_name = employee_folder.name
            for image_path in employee_folder.iterdir():
                if image_path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                    continue
                jobs.append(
                    (
                        image_path,
                        employee_name,
                        max_width,
                        num_jitters,
                        encoding_model,
                        min_laplacian_var,
                        min_brightness,
                        min_face_area_ratio,
                    )
                )

        if not jobs:
            raise ValueError("No dataset images found. Add employee images and retry.")

        total_jobs = len(jobs)
        processed_jobs = 0
        if progress_callback:
            progress_callback(0, total_jobs, "Preparing training jobs")

        if requested_workers <= 0:
            max_workers = min(max(1, os.cpu_count() or 1), 4)
        else:
            max_workers = requested_workers

        try:
            with ProcessPoolExecutor(max_workers=max_workers) as executor:
                futures = [executor.submit(_encode_image_task, job) for job in jobs]
                for future in as_completed(futures):
                    result = future.result()
                    processed_jobs += 1
                    if not result["ok"]:
                        skipped_files.append({"file": result["file"], "reason": result["reason"]})
                        if progress_callback:
                            progress_callback(
                                processed_jobs,
                                total_jobs,
                                f"Skipped: {Path(result['file']).name} ({result['reason']})",
                            )
                        continue
                    known_encodings.append(result["encoding"])
                    known_names.append(result["employee_name"])
                    if progress_callback:
                        progress_callback(
                            processed_jobs,
                            total_jobs,
                            f"Processed: {Path(result['file']).name}",
                        )
        except Exception:
            # Fallback for restricted environments where multiprocessing is limited.
            for job in jobs:
                result = _encode_image_task(job)
                processed_jobs += 1
                if not result["ok"]:
                    skipped_files.append({"file": result["file"], "reason": result["reason"]})
                    if progress_callback:
                        progress_callback(
                            processed_jobs,
                            total_jobs,
                            f"Skipped: {Path(result['file']).name} ({result['reason']})",
                        )
                    continue
                known_encodings.append(result["encoding"])
                known_names.append(result["employee_name"])
                if progress_callback:
                    progress_callback(
                        processed_jobs,
                        total_jobs,
                        f"Processed: {Path(result['file']).name}",
                    )

        if not known_encodings:
            raise ValueError("No valid face encodings found. Add clear face images and try again.")

        ensure_dir(self.model_path.parent)
        with open(self.model_path, "wb") as f:
            pickle.dump(
                {
                    "encodings": known_encodings,
                    "names": known_names,
                    "face_detection_model": "hog",
                    "quality_filters": {
                        "min_laplacian_var": float(min_laplacian_var),
                        "min_brightness": float(min_brightness),
                        "min_face_area_ratio": float(min_face_area_ratio),
                    },
                },
                f,
            )

        if progress_callback:
            progress_callback(total_jobs, total_jobs, "Training completed")

        return {
            "message": "Model trained successfully",
            "employees": sorted(list({name for name in known_names})),
            "total_encodings": len(known_encodings),
            "skipped": skipped_files,
            "model_path": str(self.model_path),
            "max_workers": max_workers,
        }


if __name__ == "__main__":
    dataset = os.getenv("DATASET_PATH", "dataset")
    model = os.getenv("MODEL_PATH", "models/face_encodings.pkl")
    trainer = ModelTrainer(dataset, model)
    result = trainer.train()
    print(result)
