# 17 — IRIS → KAREN Screen Mapping

## Purpose
Map KAREN functionality onto the existing IRIS UI instead of designing new screens.

| KAREN screen | IRIS source pattern | Required treatment |
|---|---|---|
| Login | IRIS login/auth page | Reuse exact page structure and components; change branding/content only if KAREN requires it |
| Dashboard | IRIS dashboard | Reuse exact shell/cards/layout; replace payroll metrics with KAREN metrics |
| Students | IRIS list/table pages | Reuse exact table/filter/action pattern |
| Student detail | IRIS detail/profile pages | Reuse exact detail layout |
| Attendance | IRIS table/report patterns | Reuse exact filters, tables, badges and actions |
| Timetable | IRIS data/table patterns | Compose from existing IRIS components |
| Classroom | IRIS management/form patterns | Reuse exact form/dialog patterns |
| Geofencing | IRIS page shell + existing visualization conventions | Add map only where required; surround it with IRIS UI |
| Notifications | IRIS notification/toast patterns | Reuse exact notification UI |
| Reports | IRIS report/table/export patterns | Preserve exact report controls |
| Documents | IRIS file/list patterns | Reuse exact file/list interactions |
| AI Assistant | IRIS chat/assistant pattern if present | Reuse exact implementation |
| Settings | IRIS settings/forms | Reuse exact settings structure |
| Audit | IRIS table/detail patterns | Reuse exact data presentation |

## Important
This is a mapping guide, not a replacement for reading the IRIS source. The actual IRIS component/page implementation is authoritative.
