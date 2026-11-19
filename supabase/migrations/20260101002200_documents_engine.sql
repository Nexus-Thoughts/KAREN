-- =============================================================================
-- 20260101002200_documents_engine
-- Phase 13 — Document Generation.
--
-- docs/10_DOCUMENT_REPORT_ENGINE.md's lifecycle:
--   REQUESTED -> AUTHORIZED -> DATA_FETCHED -> VALIDATED -> RENDERED
--             -> STORED -> DELIVERED
-- (FAILED reachable from any non-terminal state). This migration makes that
-- a real, structurally-enforced state machine (cims.validate_document_status_transition,
-- a BEFORE UPDATE trigger — the same "not just an app convention" bar every
-- other lifecycle in this schema is held to: class_session_status,
-- attendance_status, presence_state, notification_status), not merely a
-- column a client can set to anything.
--
-- "Generated artifacts inherit user authorization scope" (docs/10) — the
-- data-fetch functions below are SECURITY INVOKER over already-RLS-scoped
-- tables, identical reasoning to Phase 12's report views (ADR-021). "The LLM
-- never invents report rows" (docs/10) does not yet apply to this phase (no
-- LLM is involved until Phase 14/KAREN) — it constrains how KAREN will call
-- these same functions later, not how this phase's own UI does.
--
-- Two private Supabase Storage buckets:
--   document-templates   — admin-uploaded .docx templates
--   generated-documents  — rendered output, one requester-scoped folder each
-- =============================================================================

create type public.document_status as enum (
  'REQUESTED', 'AUTHORIZED', 'DATA_FETCHED', 'VALIDATED', 'RENDERED', 'STORED', 'DELIVERED', 'FAILED'
);

-- -----------------------------------------------------------------------------
-- document_templates — admin-managed .docx templates. Not gated by a new
-- permission key (docs/04's catalogue has only documents.read/documents.generate,
-- neither of which means "may define a template") — template management is
-- admin-only via cims.is_admin() directly, the same pattern CAMPUS geofence
-- writes use regardless of who else holds geofences.write (docs/22 ADR
-- accompanying 20260101001300_geofences).
-- -----------------------------------------------------------------------------
create table public.document_templates (
  id              uuid primary key default extensions.gen_random_uuid(),
  name            text        not null,
  description     text,
  applies_to      text        not null, -- free-form category, e.g. 'STUDENT_ATTENDANCE_CERTIFICATE'
  storage_path    text        not null, -- path within the document-templates bucket
  variable_schema jsonb       not null default '[]'::jsonb, -- [{key,label}], documents which merge fields the template expects
  status          public.entity_status not null default 'ACTIVE',
  created_by      uuid        references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint document_templates_name_not_blank check (length(btrim(name)) > 0)
);

create trigger document_templates_set_updated_at before update on public.document_templates
  for each row execute function cims.set_updated_at();
create trigger document_templates_audit after insert or update or delete on public.document_templates
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- documents — one row per generation request, carrying the lifecycle above.
-- variables stores the actual resolved merge data at generation time (the
-- audit record of what was fetched, not what an LLM might later claim was
-- fetched — the same "no invented rows" discipline docs/10 requires,
-- structurally, since a later reader of this row sees exactly what was used).
-- -----------------------------------------------------------------------------
create table public.documents (
  id              uuid primary key default extensions.gen_random_uuid(),
  template_id     uuid        not null references public.document_templates (id) on delete restrict,
  requested_by    uuid        not null references public.users (id) on delete cascade,
  entity_type     text        not null, -- e.g. 'STUDENT'
  entity_id       uuid,
  format          text        not null default 'DOCX',
  variables       jsonb,
  status          public.document_status not null default 'REQUESTED',
  storage_path    text,       -- set once STORED; path within generated-documents bucket
  failed_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint documents_format_known check (format in ('DOCX', 'CSV', 'JSON')),
  constraint documents_failed_needs_reason check (status <> 'FAILED' or failed_reason is not null)
);

create index documents_requested_by_idx on public.documents (requested_by, created_at desc);

create trigger documents_set_updated_at before update on public.documents
  for each row execute function cims.set_updated_at();
create trigger documents_audit after insert or update on public.documents
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- The state machine itself. Monotonic forward progress only (a requester
-- cannot regress a document, e.g. STORED back to REQUESTED); FAILED is
-- reachable from any non-terminal state; DELIVERED and FAILED are terminal.
-- Structurally identical in spirit to attendance_status/presence_state's
-- forward-only discipline elsewhere in this schema.
-- -----------------------------------------------------------------------------
create function cims.validate_document_status_transition()
returns trigger
language plpgsql
as $$
declare
  v_order text[] := array['REQUESTED','AUTHORIZED','DATA_FETCHED','VALIDATED','RENDERED','STORED','DELIVERED'];
  v_old_idx int;
  v_new_idx int;
begin
  if old.status in ('DELIVERED', 'FAILED') then
    raise exception 'Document % is in a terminal state (%) and cannot be modified' , old.id, old.status
      using errcode = '23514';
  end if;

  if new.status = 'FAILED' then
    return new;
  end if;

  v_old_idx := array_position(v_order, old.status::text);
  v_new_idx := array_position(v_order, new.status::text);

  if v_new_idx < v_old_idx then
    raise exception 'Document status cannot move backward (% -> %)', old.status, new.status
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger documents_validate_status_transition before update of status on public.documents
  for each row execute function cims.validate_document_status_transition();

alter table public.document_templates enable row level security;
alter table public.documents          enable row level security;

-- -----------------------------------------------------------------------------
-- document_templates RLS — read requires documents.read; write is admin-only.
-- -----------------------------------------------------------------------------
create policy document_templates_select on public.document_templates
  for select to authenticated
  using (cims.is_active_user() and cims.has_permission('documents.read'));

create policy document_templates_write on public.document_templates
  for all to authenticated
  using (cims.is_active_user() and cims.is_admin())
  with check (cims.is_active_user() and cims.is_admin());

-- -----------------------------------------------------------------------------
-- documents RLS — a caller sees their own requests, or (documents.read +
-- admin) sees everything. Deliberately simple: entity-level scope (e.g. "can
-- this HOD see a document generated about a student in their department")
-- is not layered on top, unlike attendance_records (ADR-015) — a generated
-- document is a copy a specific person asked for, not a live institutional
-- record, so "who asked for it" is the meaningful scope here. Insert
-- requires documents.generate (every role holds it, including STUDENT, for
-- self-service documents like an attendance certificate).
-- -----------------------------------------------------------------------------
create policy documents_select on public.documents
  for select to authenticated
  using (
    cims.is_active_user()
    and (requested_by = auth.uid() or (cims.has_permission('documents.read') and cims.is_admin()))
  );

create policy documents_insert on public.documents
  for insert to authenticated
  with check (cims.is_active_user() and cims.has_permission('documents.generate') and requested_by = auth.uid());

create policy documents_update_self on public.documents
  for update to authenticated
  using (cims.is_active_user() and requested_by = auth.uid())
  with check (requested_by = auth.uid());

-- =============================================================================
-- Data-fetch functions — the "authoritative service" docs/10 requires a
-- renderer (eventually KAREN, Phase 14) to call rather than inventing rows.
-- SECURITY INVOKER, so the caller's own RLS reach is what actually decides
-- what comes back, exactly like Phase 12's report views (ADR-021).
-- =============================================================================
create function public.document_data_student_attendance(
  p_student_id uuid,
  p_from date default null,
  p_to date default null
)
returns table (
  full_name text,
  register_number text,
  department_name text,
  section_name text,
  present_count int,
  absent_count int,
  total_count int,
  present_rate_pct numeric
)
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select
    u.full_name, st.register_number, d.name, sec.name,
    count(*) filter (where ar.status in ('PRESENT', 'LATE', 'MANUAL_PRESENT'))::int,
    count(*) filter (where ar.status in ('ABSENT', 'MANUAL_ABSENT'))::int,
    count(*)::int,
    round(
      100.0 * count(*) filter (where ar.status in ('PRESENT', 'LATE', 'MANUAL_PRESENT'))
      / nullif(count(*), 0), 1
    )
  from public.students st
  left join public.users u on u.id = st.user_id
  left join public.departments d on d.id = st.department_id
  left join public.sections sec on sec.id = st.section_id
  left join public.attendance_records ar on ar.student_id = st.id
  left join public.class_sessions cs on cs.id = ar.class_session_id
    and (p_from is null or cs.session_date >= p_from)
    and (p_to is null or cs.session_date <= p_to)
  where st.id = p_student_id
  group by u.full_name, st.register_number, d.name, sec.name;
$$;

comment on function public.document_data_student_attendance is
  'SECURITY INVOKER — subject to attendance_records_select RLS (docs/22 ADR-015) as the calling user: a student can only ever fetch their own data this way, staff only students within their reach.';

grant execute on function public.document_data_student_attendance(uuid, date, date) to authenticated;

-- =============================================================================
-- Storage — two private buckets.
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('document-templates', 'document-templates', false, 10485760),
  ('generated-documents', 'generated-documents', false, 10485760)
on conflict (id) do nothing;

-- document-templates: read requires documents.read; write is admin-only.
create policy document_templates_bucket_select on storage.objects
  for select to authenticated
  using (bucket_id = 'document-templates' and cims.has_permission('documents.read'));

create policy document_templates_bucket_write on storage.objects
  for all to authenticated
  using (bucket_id = 'document-templates' and cims.is_admin())
  with check (bucket_id = 'document-templates' and cims.is_admin());

-- generated-documents: object path convention is `${requester_user_id}/${document_id}.${ext}`
-- — a requester may read/write only within their own folder; an admin may
-- read any (for support/audit), never write into another user's folder.
create policy generated_documents_bucket_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'generated-documents'
    and ((storage.foldername(name))[1] = auth.uid()::text or cims.is_admin())
  );

create policy generated_documents_bucket_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'generated-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy generated_documents_bucket_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'generated-documents' and (storage.foldername(name))[1] = auth.uid()::text);
