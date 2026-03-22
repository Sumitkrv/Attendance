# MongoDB Atlas Step-by-Step (Phase 2)

## 1) Create Atlas Project + Cluster
1. Open MongoDB Atlas.
2. Create a new project (example: `face-attendance-prod`).
3. Create a cluster (M10 or higher).
4. Region: choose nearest to your backend server.

## 2) Create Database User
1. Go to **Database Access**.
2. Create user with strong password.
3. Role: `readWriteAnyDatabase` (or scoped `readWrite` for `face_attendance`).
4. Save username/password securely.

## 3) Network Access
1. Go to **Network Access**.
2. Add only your server public IP(s).
3. Do not keep `0.0.0.0/0` in production.

## 4) Configure Backend Env
Update backend `.env`:

```env
MONGODB_URI=mongodb+srv://<db_user>:<db_password>@<cluster-host>/<db_name>?retryWrites=true&w=majority
MONGODB_DB=face_attendance
USE_MOCK_DB=false
```

## 5) Preflight Connection + Indexes
Run from project root:

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/atlas_preflight.py
```

Expected output includes `✅ Atlas preflight OK`.

## 6) Start Backend (No Mock DB)
```bash
cd backend
USE_MOCK_DB=false PYTHONPATH=. .venv/bin/gunicorn -w 1 -b 127.0.0.1:5001 src.api.app:app
```

## 7) Verify Health
```bash
curl -s -i http://127.0.0.1:5001/health
```

Expect: `HTTP/1.1 200 OK`.

## 8) Validate App Writes (real DB)
- Register one employee from admin panel.
- Scan attendance once.
- Check admin attendance list.

## 9) Quick API Validation
```bash
# admin login
auth=$(curl -sS -X POST http://127.0.0.1:5001/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

# employees list
curl -sS http://127.0.0.1:5001/employees -H "Authorization: Bearer $auth"

# attendance list
curl -sS http://127.0.0.1:5001/attendance -H "Authorization: Bearer $auth"
```

## 10) Recommended Next
- Enable Atlas backups.
- Rotate `SECRET_KEY` and admin password.
- Restrict `ALLOWED_ORIGINS` in backend env.
