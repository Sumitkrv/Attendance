"""
Optional utility script to capture employee face images from webcam.
Usage:
python -m src.capture_faces --name "sumit" --count 20
"""

import argparse
from pathlib import Path

import cv2

from src.utils.helpers import ensure_dir, slugify_name


def capture_faces(name: str, count: int, dataset_path: str = "dataset"):
    folder_name = slugify_name(name)
    target_dir = ensure_dir(Path(dataset_path) / folder_name)

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        raise RuntimeError("Unable to open camera")

    saved = 0
    print("Press SPACE to capture image, Q to quit")

    try:
        while saved < count:
            ret, frame = cap.read()
            if not ret:
                continue

            cv2.imshow("Capture Faces", frame)
            key = cv2.waitKey(1) & 0xFF

            if key == ord(" "):
                saved += 1
                image_path = target_dir / f"img{saved}.jpg"
                cv2.imwrite(str(image_path), frame)
                print(f"Saved {image_path}")
            elif key == ord("q"):
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()

    print(f"Captured {saved} images in {target_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True, help="Employee name")
    parser.add_argument("--count", type=int, default=20, help="Number of images to capture")
    parser.add_argument("--dataset", default="dataset", help="Dataset root folder")
    args = parser.parse_args()

    capture_faces(args.name, args.count, args.dataset)
