# CHANGELOG

## Branch Plan
- Intended branch: `feat/dashboard-v2-upgrade`
- Blocker: repository has no `.git` metadata in this workspace, so branch/commit actions could not be executed.

## Phase 1 — Fixes & Polish
- Personalized greeting from token claims (`first_name` / `name` / `username`) with fallback.
- Added reusable `EmptyState` component and replaced multiple dashboard empty text blocks.
- Trend pill suppression added for zero value + no baseline (`HrmsMetricCard` `hasBaseline`).
- Added derived auto-absent logic after cutoff (`VITE_AUTO_ABSENT_CUTOFF_HOUR`, default 10).
- KPI cards made clickable and wired to filtered attendance/request views.
- Refresh button now uses dedicated `handleManualRefresh()` with spinner/disabled state + success toast.
- Alert grouping dedupes overlapping absenteeism alerts into `Attendance Coverage Risk`.
- Pending requests subtitle updated to:
  - `0 pending · X approved · Y rejected (this month)`
- Avg check-in/work-hours no-data text updated to `N/A — no data yet`.
- Added auto-refresh indicator (`Auto-refresh: 60s`) + pulsing dot near Last refresh.

## Phase 2 — New Widgets
- Added Department-wise Attendance Breakdown (horizontal bar chart).
- Added Birthdays & Work Anniversaries (upcoming 7 days).
- Added New Joiners & Exits This Month counters + avatar row.
- Added Overtime Tracker (top 5 > 9h in scope).
- Added Leave Balance Alerts (<2 remaining, if field available).
- Added Holiday Calendar mini-widget (next 3 upcoming, fallback list).
- Added widget export actions (CSV/Excel/PDF) for:
  - Weekly Attendance Trend
  - Attendance Distribution

## Phase 3 — UX & Interactivity
- Added Custom range option next to Today/Week/Month for overview.
- Added global search bar in header with 300ms debounce and Cmd/Ctrl+K focus.
- Added activity timeline drill-down chips: All / Check-ins / Approvals / Edits / System.
- Added bell Notification Center slide-in drawer with grouping + mark read/mark all read.

## Phase 4 — Smart Features
- Added predictive absenteeism heuristic (2+ Friday absences in last 4 weeks).
- Added anomaly insight when today check-ins drop >40% vs 7-day average.
- Added keyboard shortcuts:
  - `R`, `T`, `W`, `M`, `/`, `Cmd/Ctrl+K`, `?`
- Added shortcuts help modal.

## Phase 5 — Polish & A11y
- Added focus-visible styles on key interactive elements.
- Added `prefers-reduced-motion` handling.
- Added responsive support additions for 375/768 breakpoints.
- Added dark-mode styles for newly introduced dashboard components.

## Feature Flag
- Risky/new dashboard enhancements are guarded with:
  - `VITE_FEATURE_DASHBOARD_V2` (enabled unless explicitly set to `0`)

## Deferred / Skipped (with reason)
- Drag-and-drop widget reordering with `@dnd-kit/core`: not yet implemented.
- Per-widget hide/show toggle gear: not yet implemented.
- Right-side bell panel is implemented as a slide-in drawer, but not full persisted server-side read-state.
- No backend cron job was added due current scope and preserving API/backend behavior; absent fallback implemented as derived frontend logic.
- Git atomic commit history could not be created due missing git repository metadata.
