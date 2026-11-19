# 04 — RBAC and Permissions

Roles:
- Admin
- HOD
- Faculty
- Mentor
- Class In-charge
- Student

## Rules
- Least privilege.
- Department/section scope where applicable.
- Students see their own data.
- Faculty sees assigned scope.
- Mentor/Class In-charge sees assigned scope.
- HOD sees authorized department scope.
- Admin has system-wide administrative access.

## AI
AI tools must call the same authorization layer as normal APIs. A prompt cannot grant permissions.

## Sensitive location
Location visibility is explicitly scoped and audited.
