# 11 — API Contract

Protected APIs must validate authentication, permission and resource scope.

Core endpoint groups:
- `/auth`
- `/users`
- `/students`
- `/departments`
- `/sections`
- `/subjects`
- `/timetable`
- `/class-sessions`
- `/classrooms`
- `/campus-geofences`
- `/location`
- `/geofence-events`
- `/attendance`
- `/notifications`
- `/ai`
- `/reports`

Every endpoint must define method, auth, permission, request schema, response schema, validation, errors and audit behavior where applicable.
