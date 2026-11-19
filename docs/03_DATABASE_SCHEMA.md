# 03 — Database Schema

Core tables:
- users
- roles
- permissions
- role_permissions
- students
- faculty
- departments
- sections
- subjects
- classrooms
- timetable_entries
- class_sessions
- attendance_records
- attendance_audits
- campus_geofences
- location_events
- geofence_events
- notifications
- documents
- knowledge_documents
- chat_sessions
- chat_messages
- generated_reports
- audit_logs

## Spatial data
Use PostGIS SRID 4326-compatible spatial types.
Use spatial indexes.
Use server-side `ST_DWithin` for classroom radius checks and appropriate polygon containment functions for campus membership.

## Integrity
Use foreign keys, unique constraints, timestamps, scoped indexes and immutable audit history for regulated changes.
