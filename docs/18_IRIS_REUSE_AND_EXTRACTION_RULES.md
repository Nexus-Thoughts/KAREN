# 18 — IRIS Reuse and Extraction Rules

## Goal
Prevent Claude from approximating IRIS.

## Rule 1 — Inspect first
Before writing a new UI component, search the IRIS repository for an existing equivalent.

## Rule 2 — Reuse actual source
If the IRIS component can be reused, import/use it rather than recreating it.

## Rule 3 — Preserve source behavior
Do not change:
- DOM/component hierarchy without need;
- class/token structure without need;
- interaction states;
- responsive behavior;
- accessibility behavior;
- animation/transitions.

## Rule 4 — Domain adaptation
Replace payroll-specific:
- labels;
- data fields;
- actions;
- API calls;
- permissions;
with KAREN equivalents while retaining the UI component.

## Rule 5 — New functionality
For geofencing/maps, attendance and KAREN-specific workflows:
- build functionality behind the existing IRIS shell;
- reuse IRIS controls around it;
- preserve IRIS spacing, typography and states.

## Rule 6 — No duplicate design systems
Do not introduce a second UI library or token system merely to implement KAREN.

## Rule 7 — Visual QA
For each major screen:
- render at the same desktop viewport used for IRIS;
- render mobile viewport;
- compare screenshot/layout;
- verify typography, spacing, controls, states and navigation.

## Rule 8 — Source wins
If this document conflicts with actual IRIS source behavior, inspect the source and preserve the source behavior.
