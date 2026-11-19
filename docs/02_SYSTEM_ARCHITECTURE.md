# 02 — System Architecture

Frontend/Mobile
 -> API/Backend
 -> Authentication/RBAC
 -> Domain services
    -> Academic
    -> Attendance
    -> Geospatial
    -> Notifications
    -> Reporting/Documents
    -> AI orchestration
 -> PostgreSQL + PostGIS
 -> Object storage
 -> Optional queue/cache/vector store

## Architectural rules
- API-first.
- Server-side authorization.
- PostGIS owns authoritative spatial calculations.
- Notification delivery is event-driven.
- AI calls controlled tools, never arbitrary SQL.
- Critical events are durable and auditable.
- Failure in one subsystem must not corrupt another.

## AI flow
User -> authenticated chat API -> intent -> permission -> tool/RAG -> structured result -> response/report.

## Geofence flow
Location sample -> validation -> PostGIS evaluation -> state transition -> event -> notification -> audit/report.
