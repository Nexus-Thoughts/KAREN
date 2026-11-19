# 01 — Product Requirements Document

## Product
KAREN

## Goal
A unified college operations platform for Admin, HOD, Faculty, Mentor, Class In-charge and Student users.

## Modules
- Authentication
- RBAC
- User/student/faculty management
- Departments/sections/subjects
- Timetable
- Classroom management
- Classroom geofencing
- Attendance
- Campus geofencing
- Student entry/exit events
- Notifications
- Dashboards
- Reports
- Documents
- AI assistant
- Knowledge/RAG
- Audit logs
- Configuration

## Core business rules
### Classroom
Authorized users enter exact classroom latitude/longitude. Default classroom radius is 20 m.

### Attendance
Campus presence is not attendance. Classroom proximity is not automatically attendance. Attendance is tied to a timetable-defined class session and approved attendance workflow.

### Campus exit
When verified student location indicates the student has exited the campus before the configured college closing time:
- create an exit event;
- notify Mentor;
- notify Class In-charge;
- notify HOD;
- prevent duplicate alerts;
- retain audit/event history.

### AI
AI answers using authoritative application tools or approved knowledge sources. AI cannot bypass RBAC and cannot fabricate live institutional data.

## Reports
Attendance, department, section, subject/session, campus entry/exit, geofence events, notifications, audit and configurable administrative reports.

## Non-functional
Secure, auditable, responsive, reliable, testable and scalable.

## Out of scope unless approved
- automatic attendance solely from GPS;
- unrestricted AI database access;
- unaudited attendance changes;
- fabricated reports.
