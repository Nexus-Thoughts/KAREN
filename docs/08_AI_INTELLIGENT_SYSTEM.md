# 08 — AI Intelligent System

## Purpose
Natural-language access to approved institutional information and controlled operations.

## Tool-first
Live/authoritative data questions use tools/APIs. The model must not guess.

## RAG
Use approved, permission-filtered documents for institutional knowledge.

## Capabilities
- attendance questions;
- student/class/department statistics;
- timetable queries;
- geofence status/events;
- notification queries;
- report generation;
- document generation.

## Safety
- no RBAC bypass;
- no arbitrary SQL;
- no fabricated values;
- no unrestricted location disclosure;
- no unauthorized actions.

## Report generation
AI selects intent/parameters. Report service fetches authoritative data, validates, renders and stores the artifact.
