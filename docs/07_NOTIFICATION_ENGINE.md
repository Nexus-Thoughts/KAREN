# 07 — Notification Engine

## Required event
`STUDENT_EXITED_CAMPUS_BEFORE_CLOSING`

Recipients:
- Mentor
- Class In-charge
- HOD

## Lifecycle
CREATED -> QUEUED -> SENT / FAILED -> RETRYING -> SENT / EXHAUSTED

## Requirements
- deduplication;
- retry;
- delivery status;
- read status;
- audit;
- role/scope validation.

Source business events must survive delivery failures.
