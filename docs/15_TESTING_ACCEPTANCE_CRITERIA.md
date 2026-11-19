# 15 — Testing and Acceptance Criteria

## Geofence
- within 20 m -> classroom proximity true;
- outside 20 m -> false;
- poor accuracy -> uncertain;
- invalid/stale/denied location -> not verified exit.

## Early exit
Verified campus OUTSIDE before closing -> one exit event + Mentor + Class In-charge + HOD notifications.

Repeated samples -> no duplicate notifications.

After closing -> no before-closing alert.

## Attendance
Campus/classroom presence alone does not create attendance.

## RBAC
Unauthorized users cannot retrieve restricted attendance/location.

## AI
Live questions use authoritative tools. Unauthorized requests are denied/scoped. No fabricated values.

## Reports
Output equals authoritative query result and respects authorization.

## Audit
Attendance changes, geofence changes, privileged location access and privileged AI tools are auditable.

## UI
Every KAREN UI page must pass the exact-IRIS visual requirement in `12_UI_UX_SPEC.md`.
