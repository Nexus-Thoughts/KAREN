-- Minimal stand-in for the pieces of the real Supabase stack (GoTrue's
-- auth.* schema, Storage's storage.* schema, and the anon/authenticated/
-- service_role roles) that this project's migrations assume exist already
-- when they run inside a real Supabase project. This is test-only scaffolding
-- so the actual 20260101*.sql migrations can be replayed and pgTAP-tested
-- against a real Postgres+PostGIS+pgvector instance without Docker/network
-- access to pull the full Supabase local stack.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'postgres';
  end if;
end
$$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists auth;
create table auth.users (
  instance_id uuid,
  id uuid primary key default gen_random_uuid(),
  aud varchar(255),
  role varchar(255),
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  confirmation_token varchar(255) default '',
  email_change text default '',
  email_change_token_new text default '',
  email_change_token_current text default '',
  recovery_token text default ''
);

create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users (id),
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Real GoTrue implementation: reads the JWT claims PostgREST sets per-request
-- via `set_config('request.jwt.claims', ..., true)`. Tests below set the same
-- GUC to impersonate a given user, exactly like a real RLS-scoped request.
-- nullif() must run BEFORE the ::json cast, same reasoning as
-- cims.write_audit's own version of this expression (audit_foundation.sql):
-- request.jwt.claims is unset (empty string outside a real PostgREST
-- request) far more often than it's a real JWT, and ''::json throws rather
-- than behaving like an absent claim. (An earlier version of this stub cast
-- to ::json before the nullif check and threw on every unauthenticated
-- write — caught the hard way while diagnosing an apparent audit-trigger
-- failure that was actually this stub, not the app; see local test notes.)
create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select (nullif(current_setting('request.jwt.claims', true), '')::json->>'sub')::uuid $$;

create or replace function auth.role() returns text
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claims', true), '')::json->>'role' $$;

create or replace function auth.jwt() returns jsonb
  language sql stable
  as $$ select coalesce(current_setting('request.jwt.claims', true)::jsonb, '{}'::jsonb) $$;

create schema if not exists storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata jsonb,
  version text
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

create or replace function storage.foldername(name text) returns text[]
  language sql immutable
  as $$ select case when array_length(string_to_array(name, '/'), 1) > 1
    then (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
    else '{}'::text[] end $$;

grant usage on schema auth, storage to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

-- Helper the test scripts below use to impersonate a user, mirroring what
-- PostgREST does per-request (SET ROLE authenticated + the JWT claims GUC).
create or replace function public.__test_login(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id::text, 'role', p_role)::text, false);
  execute format('set role %I', p_role);
end;
$$;

create or replace function public.__test_logout()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', false);
  reset role;
end;
$$;
