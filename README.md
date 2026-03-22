# Face Recognition Attendance System

Production-ready, modular Face Recognition Attendance System for offices.

## What was improved
- Liveness detection (blink + face movement checks)
- Anti-spoofing guard (face texture sharpness check)
- Faster model training (parallel encoding + image resize)
- Faster runtime recognition (frame skipping + optimized face distance match)
- Production security (JWT auth, protected endpoints, CORS allowlist, upload size limit, rate limiting)
- Dockerized deployment (MongoDB + Python Backend)

## Stack
- Backend: Python, Flask, OpenCV, face-recognition, MongoDB
- Database: MongoDB
- Frontend: React + Vite

## Project Structure

face-attendance-system/
- backend/
  - dataset/
  - models/
  - src/
    - api/app.py
    - attendance/attendance_manager.py
    - utils/helpers.py
    - capture_faces.py
    - train_model.py
    - recognize_faces.py
  - requirements.txt
  - .env.example

## 1) Prerequisites (Windows/Mac/Linux)

- Python 3.10+
- MongoDB running locally or remotely
- Webcam

### OS Notes
- **Windows**: Install "Visual Studio Build Tools" if `face-recognition` wheel is unavailable.
- **macOS**: `xcode-select --install` and `brew install cmake` may be required.
- **Linux**: Install build deps (`cmake`, `build-essential`, `python3-dev`) if needed.

## 2) Backend Setup

1. Go to backend folder.
2. Create virtual environment.
3. Install requirements.
4. Copy environment file and update values.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # Windows PowerShell: copy .env.example .env
```

Start backend:

```bash
python src/api/app.py
```

Backend runs on `http://localhost:5001` by default.

## 3) Frontend Setup (Restored UI)

```bash
cd frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Frontend routes:

- `http://127.0.0.1:5173/admin`
- `http://127.0.0.1:5173/user`

The backend CORS allowlist must include `http://127.0.0.1:5173` and `http://localhost:5173` (already set in `backend/.env.dev`).

> Note: all admin APIs (except `/health` and `/admin/login`) now require JWT bearer token.

## Environment Config Split

Use separate backend environment files per stage:

- Backend: `backend/.env.dev`, `backend/.env.staging`, `backend/.env.prod`

Backend env loading priority:

1. `ENV_FILE` (explicit file path)
2. `backend/.env.<APP_ENV>` (for example `APP_ENV=dev|staging|prod`)
3. fallback `backend/.env` (backward compatibility)

### Safe defaults policy

- Keep only safe defaults in tracked env files.
- Never commit real secrets to Git.
- Store secrets in secret manager / deployment platform variables.

### Required production backend variables

- `SECRET_KEY` (must not be default)
- `MONGODB_URI`
- `ALLOWED_ORIGINS`
- admin credentials/hash:
  - `ADMIN_USERNAME`
  - `ADMIN_PASSWORD_HASH` (preferred) or `ADMIN_PASSWORD`
- geofence settings:
  - `OFFICE_LAT`
  - `OFFICE_LNG`
  - `OFFICE_RADIUS_METERS`

When `APP_ENV=prod`, backend startup validates these variables and fails fast if missing.

## 4) Add New Employees

### Option A (API with images)
Use `POST /register_employee` as multipart/form-data:
- `name`: employee name
- `department`: department
- `files[]`: one or more face images

### Option B (capture from webcam)

```bash
cd backend
source .venv/bin/activate  # Windows: .venv\Scripts\activate
python -m src.capture_faces --name "sumit" --count 20
```

This creates images under `backend/dataset/sumit/`.

## 5) Train Model

- API: `POST /train_model`
- Or CLI:

```bash
cd backend
source .venv/bin/activate
python -m src.train_model
```

Generated model file:
- `backend/models/face_encodings.pkl`

## 6) Start Recognition Camera

Call API endpoint:
- `POST /start_camera`

Stop camera:
- `POST /stop_camera`

Check camera state:
- `GET /camera_status`

When a known employee is detected:
- first detection of day -> `check_in`
- later detection -> `check_out` (duplicate prevention window applied)

### Liveness + Anti-spoof flow
Attendance is marked only after passive checks pass:
- `texture_ok`: face ROI Laplacian variance threshold
- `blink_ok`: blink event detected with EAR threshold logic
- `movement_ok`: slight facial movement across frames

Default rule:
- mark attendance only if `texture_ok` and (`blink_ok` or `movement_ok`)

## 7) API Endpoints

- `POST /register_employee`
- `POST /train_model`
- `POST /start_camera`
- `POST /stop_camera`
- `GET /camera_status`
- `GET /attendance?date=YYYY-MM-DD`
- `GET /employees`
- `POST /admin/login`
- `GET /health`

### Auth
- Login: `POST /admin/login` returns JWT token.
- Send token in header for protected endpoints:
  - `Authorization: Bearer <token>`

## 8) MongoDB Schema

### employees
- `_id`
- `name`
- `department`
- `image_folder`
- `created_at`
- `updated_at`

### attendance
- `_id`
- `employee_id`
- `employee_name`
- `date`
- `check_in`
- `check_out`
- `created_at`
- `updated_at`

## 9) Python-Only Usage

- Use backend APIs directly (Postman/curl/custom Python client)
- Use CLI scripts for capture and training
- Start/stop recognition camera through API endpoints

## 10) Production Notes

- Set strong `SECRET_KEY` in `backend/.env`
- Use `ADMIN_PASSWORD_HASH` instead of plain password (recommended)
- Restrict `ALLOWED_ORIGINS` to your exact domain list
- Keep `MAX_CONTENT_LENGTH_MB` low for upload abuse control
- Run behind HTTPS reverse proxy
- Use managed MongoDB with backups + network policy

## 11) Docker Setup

### Run Python backend + MongoDB with Docker Compose

```bash
cp backend/.env.example backend/.env
docker compose up --build
```

Services:
- Backend: `http://localhost:5001`
- MongoDB: `mongodb://localhost:27017`

### Stop stack

```bash
docker compose down
```

## 12) Performance tuning knobs (.env)

- `PROCESS_EVERY_N_FRAMES` (higher = less CPU)
- `FRAME_RESIZE_SCALE` (lower = faster, less accurate)
- `RECOGNITION_TOLERANCE` (lower = stricter match)
- `DISPLAY_PREVIEW` (set `true` only for local desktop preview)
- `TRAIN_IMAGE_MAX_WIDTH` (smaller = faster encoding)
- `TRAIN_MAX_WORKERS` (0 = auto)
