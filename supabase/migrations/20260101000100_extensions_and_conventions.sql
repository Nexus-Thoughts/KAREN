-- =============================================================================
-- 20260101000100_extensions_and_conventions
-- Phase 3 — Supabase foundation.
--
-- Enables the extensions KAREN depends on and establishes conventions every
-- later migration relies on: the `cims` private schema, updated_at triggering
-- and the immutable audit substrate.
--
-- docs/02_SYSTEM_ARCHITECTURE.md, docs/03_DATABASE_SCHEMA.md
-- =============================================================================

-- Supabase places extensions in a dedicated schema to keep `public` clean.
create schema if not exists extensions;

-- PostGIS owns every authoritative spatial calculation (docs/05).
create extension if not exists postgis with schema extensions;
-- gen_random_uuid(), digest() for audit hash chaining.
create extension if not exists pgcrypto with schema extensions;
-- Trigram search for student/faculty name lookup without seq scans.
create extension if not exists pg_trgm with schema extensions;
-- Composite GiST indexes mixing scalar + spatial columns.
create extension if not exists btree_gist with schema extensions;
-- Case-insensitive text for email columns (public.users.email, public.students.contact_email).
create extension if not exists citext with schema extensions;

-- `vector` backs KAREN's RAG embeddings (Phase 16). Enabled now so the
-- extension surface is fixed early; the tables arrive with that phase.
create extension if not exists vector with schema extensions;

-- -----------------------------------------------------------------------------
-- Private schema.
--
-- `cims` holds helper functions, RBAC internals and anything that must not be
-- reachable through PostgREST. It is deliberately NOT in `[api].schemas`, so
-- nothing here is exposed over HTTP even by accident.
-- -----------------------------------------------------------------------------
create schema if not exists cims;

revoke all on schema cims from public, anon, authenticated;
grant usage on schema cims to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Convention: every mutable table carries created_at / updated_at, and
-- updated_at is maintained by the database, never by the client.
-- -----------------------------------------------------------------------------
create or replace function cims.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function cims.set_updated_at is
  'BEFORE UPDATE trigger. Maintains updated_at server-side so a client cannot backdate a record.';

-- -----------------------------------------------------------------------------
-- Convention: reject client-supplied values for columns the server owns.
-- Used on audit tables to keep history immutable.
-- -----------------------------------------------------------------------------
create or replace function cims.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Table %.% is append-only; % is not permitted',
    tg_table_schema, tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

comment on function cims.reject_mutation is
  'Trigger that blocks UPDATE/DELETE. Enforces append-only audit history at the database level (docs/06, docs/49).';
