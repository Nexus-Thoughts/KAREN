# 12 — EXACT IRIS UI SPECIFICATION

## Absolute requirement
KAREN must use the EXACT SAME UI as IRIS Payroll.

Not "similar."
Not "inspired by."
Not "same design language."
Not "same colors."

The existing IRIS frontend implementation is the canonical UI implementation.

## What changes
Only:
- page content;
- labels;
- domain data;
- domain actions;
- KAREN-specific workflows.

## What does NOT change
- application shell;
- header;
- sidebar;
- navigation behavior;
- typography;
- colors;
- spacing;
- sizing;
- borders;
- radii;
- shadows/elevation;
- cards;
- buttons;
- inputs;
- tables;
- dropdowns;
- dialogs;
- toasts;
- loading states;
- empty states;
- error states;
- icons;
- charts;
- animations;
- responsive behavior;
- theme behavior;
- AI/chat visual treatment where applicable.

## Implementation method
Do not rebuild the UI from a textual description.

For every KAREN screen:
1. locate the closest IRIS page/component;
2. reuse its actual component implementation;
3. preserve its styling and interaction behavior;
4. replace payroll-specific content with KAREN content;
5. add only the functionality KAREN requires;
6. keep the resulting page visually identical to the IRIS equivalent.

## New KAREN screens
When there is no direct IRIS equivalent:
- compose the page from existing IRIS components;
- use the exact existing IRIS shell;
- use existing IRIS spacing/tokens/states;
- do not invent a new visual component unless technically necessary.

## KAREN navigation
Dashboard
Students
Attendance
Timetable
Classrooms
Geofencing
Notifications
Reports
Documents
AI Assistant
Settings
Audit

The navigation must use the actual IRIS navigation component and behavior.

## Validation
A reviewer should be able to compare KAREN and IRIS screenshots and identify the same UI implementation, with differences attributable only to content and functionality.

## Golden rule
**IRIS frontend code is the UI source of truth. This document never overrides the actual IRIS source code.**
