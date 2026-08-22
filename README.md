# StaffSphere HRMS

StaffSphere is a self-hosted human-resources management system for attendance, payroll, employee self-service, and geofenced check-ins. It provides separate administrator and employee workspaces backed by a Flask API and a React application.

## Highlights

- Role-based administrator and employee portals with JWT authentication
- Employee onboarding, departments, roles, company management, and audit logs
- Location-based attendance with configurable office geofencing
- Attendance policies, shift scheduling, manual corrections, leave requests, holidays, and reports
- Payroll calculation, salary structures, payslips, reimbursements, tax/TDS utilities, and bulk payroll runs
- Employee assets, helpdesk tickets, tasks, notifications, and account-security controls
- Multi-company/tenant scoping, white-label settings, Cloudinary-backed assets, Redis rate-limit storage, and optional Sentry monitoring
- English and Hindi interface support, responsive UI, export tools, and real-time update hooks

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 18, Vite, React Router, Zustand, TanStack Query, Tailwind CSS, Recharts |
| API | Python, Flask, PyMongo, JWT, Flask-Limiter |
| Data | MongoDB; SQLite is used by the attendance-policy engine |
| Supporting services | Redis, Cloudinary (optional), Sentry (optional) |
| Deployment | Docker, Docker Compose, Gunicorn, Vercel configuration |

## Repository layout

```text
.
├── frontend/                 # React/Vite web application
│   └── src/pages/            # Admin and employee workspaces
├── backend/
│   ├── src/api/app.py        # Main Flask application
│   ├── src/routes/           # Payroll, leave, reports, shifts, etc.
│   ├── src/policy_engine/    # Attendance-policy service
│   ├── app/                  # Separate FastAPI starter scaffold
│   └── tests/                # Backend tests
├── persistent/               # Runtime data and employee uploads (do not publish real data)
├── docker-compose.yml        # MongoDB, Redis, backend, and Uptime Kuma services
└── e2e/                      # Playwright end-to-end test setup
```

## Prerequisites

- Node.js 18 or later
- Python 3.10 or later (the Docker image uses Python 3.11)
- MongoDB 7+ for the primary application data store
- Redis 7+ when using distributed rate limiting

## Run locally

### 1. Configure the backend

```bash
cd backend
cp .env.example .env
```

Update `backend/.env` with a strong `SECRET_KEY`, the MongoDB connection details, allowed frontend origins, administrator credentials, and (when enabled) office geofence coordinates. Do not commit this file.

Create an environment and install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Start the main Flask API:

```bash
python src/api/app.py
```

The API listens on `http://127.0.0.1:5001` by default. Confirm it is running with `GET /health`.

### 2. Configure and start the frontend

In another terminal:

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Set `VITE_API_URL=http://127.0.0.1:5001` in `frontend/.env` when using the default local backend. Open `http://127.0.0.1:5173`; the root route redirects to the administrator portal.

## Docker Compose

Docker Compose starts MongoDB, Redis, the Flask backend, and Uptime Kuma:

```bash
cp backend/.env.example backend/.env
# Edit backend/.env before using it outside local development.
docker compose up --build
```

Services are exposed at:

| Service | Address |
| --- | --- |
| Flask API | `http://localhost:5001` |
| MongoDB | `mongodb://localhost:27017` |
| Redis | `redis://localhost:6379` |
| Uptime Kuma | `http://localhost:3001` |

For production, inject secrets through the hosting platform or a secret manager, use an exact `ALLOWED_ORIGINS` list, and configure persistent volumes/backups for MongoDB and runtime data.

## Environment configuration

The backend loads configuration in this order:

1. File specified by `ENV_FILE`
2. `backend/.env.<APP_ENV>` (for example, `.env.dev`, `.env.staging`, or `.env.prod`)
3. `backend/.env`

Key backend settings include:

| Variable | Purpose |
| --- | --- |
| `SECRET_KEY` | Token signing secret; use a long, unique production value |
| `MONGODB_URI`, `MONGODB_DB` | Primary application database |
| `ALLOWED_ORIGINS` | Comma-separated browser origins permitted by CORS |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` | Initial/admin authentication configuration |
| `ENABLE_OFFICE_GEOFENCE`, `OFFICE_LAT`, `OFFICE_LNG`, `OFFICE_RADIUS_METERS` | Location-bound attendance controls |
| `ASSETS_STORAGE` | Set to `cloudinary` to store employee assets in Cloudinary |
| `RATE_LIMIT_STORAGE_URI` | Redis URL for shared rate-limit storage |
| `SENTRY_DSN` | Optional Sentry error reporting endpoint |

Refer to [`backend/.env.example`](backend/.env.example) for the full documented set of options. Production startup validates required configuration and should not rely on the sample credential values.

## Geofenced attendance

Employees can check in and check out from the employee portal. Enable office-location validation by setting the following values in `backend/.env`:

```env
ENABLE_OFFICE_GEOFENCE=true
OFFICE_LAT=<office-latitude>
OFFICE_LNG=<office-longitude>
OFFICE_RADIUS_METERS=100
```

Adjust the allowed radius to suit the office location and test it on representative employee devices before enabling it for the whole organization.

## API overview

The API exposes routes for authentication, attendance, employees, payroll, leave, assets, reporting, companies, and account security. Common entry points include:

| Area | Examples |
| --- | --- |
| Health and authentication | `GET /health`, `POST /admin/login`, `POST /user/login` |
| Attendance | `POST /user/mark_entry_on_login`, `GET /attendance`, `POST /attendance/manual` |
| Employees | `GET /api/employees`, `POST /api/employees`, `PUT /api/employees/:employee_id` |
| Payroll | `GET /api/payroll/summary`, `POST /api/payroll/calculate` |
| Employee self-service | `GET /user/attendance_today`, `GET /user/payroll/payslips`, `POST /user/reimbursements` |

Protected endpoints require an admin or user JWT, as appropriate. The running application provides additional API-related routes and module blueprints; review the route source before integrating a client.

## Tests and builds

```bash
# Frontend unit tests
cd frontend && npm run test

# Frontend production build
cd frontend && npm run build

# Backend tests
cd backend && pytest

# End-to-end test setup
cd e2e && npm install && npx playwright test
```

## Security checklist before publishing to GitHub

- Keep `.env` files, API keys, database dumps, and user uploads out of version control.
- Remove or replace the contents of `persistent/` if they contain real employee data, uploads, or database exports.
- Use password hashes (`ADMIN_PASSWORD_HASH`) and rotate any credentials that have already been exposed.
- Configure HTTPS, restrictive CORS, backups, retention rules, access logs, and role permissions before production use.
- Review applicable employment, location-data, and privacy requirements before enabling geofenced attendance.

## Additional documentation

- [`MIGRATION_NOTES.md`](MIGRATION_NOTES.md) — migration notes
- [`ATLAS_STEP_BY_STEP.md`](ATLAS_STEP_BY_STEP.md) — MongoDB Atlas guidance
- [`SCREENSHOTS.md`](SCREENSHOTS.md) — UI screenshots/reference
- [`TESTS_REPORT.md`](TESTS_REPORT.md) — existing test summary

## License

No license file is currently included. Add a `LICENSE` before publishing if you intend others to use, modify, or redistribute this project.
