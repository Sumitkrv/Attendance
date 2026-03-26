# FastAPI Starter Backend

## Run locally

1. Create virtual environment and install dependencies:

   pip install -r requirements-fastapi.txt

2. Start API from backend folder:

   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

3. Open docs:

   http://127.0.0.1:8000/docs

## Endpoints

- `POST /api/v1/login`
- `POST /api/v1/mark-attendance`
- `GET /api/v1/attendance-history/{user_id}`
