# MIGRATION_NOTES

## Required
1. Install frontend dependencies:
   - `cd frontend && npm install`

## New/Used Environment Variables
Set in frontend runtime env (optional defaults already provided):

- `VITE_FEATURE_DASHBOARD_V2`
  - `1` (default) enables dashboard v2 enhancements
  - `0` disables v2 enhancements
- `VITE_DASHBOARD_AUTO_REFRESH_SECONDS`
  - Default: `60`
- `VITE_AUTO_ABSENT_CUTOFF_HOUR`
  - Default: `10` (10:00 AM local)

## Notes
- No database schema migration was performed.
- No backend API contract was broken.
- Auto-absent behavior is implemented as derived frontend logic after cutoff when no attendance rows exist.
