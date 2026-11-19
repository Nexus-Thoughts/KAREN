# 05 — Geofencing Specification

## Classroom
- exact latitude/longitude supplied by authorized user;
- default radius 20 m;
- authoritative distance calculated server-side with PostGIS.

## Campus
- configured polygon;
- point-in-polygon evaluation server-side.

## Student states
UNKNOWN -> INSIDE -> EXIT_CANDIDATE -> EXIT_VERIFIED -> OUTSIDE -> REENTRY_CANDIDATE -> INSIDE

## Early exit
Verified OUTSIDE + current time before college closing time -> event + Mentor notification + Class In-charge notification + HOD notification.

## Accuracy
Poor/stale/invalid location must become UNKNOWN or rejected, never silently OUTSIDE.

## Deduplication
Repeated GPS samples must not create repeated exit events/notifications.

## Privacy
Minimize collection, restrict access, retain according to policy and audit privileged access.
