-- =============================================================================
-- 011_phase13_documents.test.sql
--
-- Covers supabase/migrations/20260101002200_documents_engine.sql: the
-- REQUESTED->...->DELIVERED state machine (forward-only, terminal states),
-- template admin-only write RLS, documents self-scoped RLS, the
-- data-fetch function's RLS inheritance, and storage.objects policies for
-- both buckets.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(15);

create schema if not exists tests;
grant usage on schema tests to anon, authenticated;

create or replace function tests.simulate_user(p_user_id uuid)
returns void
language sql
as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  select set_config('role', 'authenticated', true);
$$;

grant execute on function tests.simulate_user(uuid) to anon, authenticated;

reset role;
select set_config('request.jwt.claims', '', true);

-- =============================================================================
-- 1. document_templates — admin-only write.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs, holds documents.read but is not admin

select throws_ok(
  $$ insert into public.document_templates (name, applies_to, storage_path) values ('Test Template', 'STUDENT_ATTENDANCE_CERTIFICATE', 'x.docx') $$,
  '42501',
  null,
  'a non-admin (HOD) cannot create a document template'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

insert into public.document_templates (id, name, applies_to, storage_path, variable_schema)
values ('50000000-0000-0000-0000-000000000001', 'Attendance Certificate', 'STUDENT_ATTENDANCE_CERTIFICATE', 'templates/attendance.docx', '[{"key":"full_name","label":"Full Name"}]');

select ok(
  (select count(*) from public.document_templates where id = '50000000-0000-0000-0000-000000000001')::int = 1,
  'an admin can create a document template'
);

-- =============================================================================
-- 2. documents — a student can request their own document.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- student.rahul

insert into public.documents (id, template_id, requested_by, entity_type, entity_id, format)
values ('50000000-0000-0000-0000-000000000101', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', 'STUDENT', '20000000-0000-0000-0000-000000000701', 'DOCX');

select is(
  (select status::text from public.documents where id = '50000000-0000-0000-0000-000000000101'),
  'REQUESTED',
  'a new document request starts at REQUESTED'
);

-- =============================================================================
-- 3. Forward-only lifecycle: valid forward transitions succeed.
-- =============================================================================
update public.documents set status = 'AUTHORIZED' where id = '50000000-0000-0000-0000-000000000101';
update public.documents set status = 'DATA_FETCHED', variables = '{"full_name":"Rahul Nair"}'::jsonb where id = '50000000-0000-0000-0000-000000000101';
update public.documents set status = 'VALIDATED' where id = '50000000-0000-0000-0000-000000000101';
update public.documents set status = 'RENDERED' where id = '50000000-0000-0000-0000-000000000101';
update public.documents set status = 'STORED', storage_path = '10000000-0000-0000-0000-000000000006/doc.docx' where id = '50000000-0000-0000-0000-000000000101';

select is(
  (select status::text from public.documents where id = '50000000-0000-0000-0000-000000000101'),
  'STORED',
  'sequential forward transitions REQUESTED -> ... -> STORED all succeed'
);

-- =============================================================================
-- 4. Regression is rejected.
-- =============================================================================
select throws_ok(
  $$ update public.documents set status = 'DATA_FETCHED' where id = '50000000-0000-0000-0000-000000000101' $$,
  '23514',
  null,
  'moving status backward (STORED -> DATA_FETCHED) is rejected'
);

-- =============================================================================
-- 5. DELIVERED is terminal.
-- =============================================================================
update public.documents set status = 'DELIVERED' where id = '50000000-0000-0000-0000-000000000101';

select throws_ok(
  $$ update public.documents set status = 'STORED' where id = '50000000-0000-0000-0000-000000000101' $$,
  '23514',
  null,
  'a DELIVERED document cannot be modified further — terminal state'
);

-- =============================================================================
-- 6. FAILED is reachable from any non-terminal state, and requires a reason.
-- =============================================================================
insert into public.documents (id, template_id, requested_by, entity_type, entity_id, format)
values ('50000000-0000-0000-0000-000000000102', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', 'STUDENT', '20000000-0000-0000-0000-000000000701', 'DOCX');

select throws_ok(
  $$ update public.documents set status = 'FAILED' where id = '50000000-0000-0000-0000-000000000102' $$,
  '23514',
  null,
  'FAILED without failed_reason is rejected by documents_failed_needs_reason'
);

update public.documents set status = 'FAILED', failed_reason = 'template render error' where id = '50000000-0000-0000-0000-000000000102';

select is(
  (select status::text from public.documents where id = '50000000-0000-0000-0000-000000000102'),
  'FAILED',
  'FAILED with a reason succeeds from REQUESTED (a non-terminal state)'
);

-- =============================================================================
-- 7. documents RLS: a different student cannot see Rahul's document, but
--    an admin can.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000007'); -- student.priya

select is(
  (select count(*) from public.documents where id = '50000000-0000-0000-0000-000000000101')::int,
  0,
  'a different student cannot see another student''s document request'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

select ok(
  (select count(*) from public.documents where id = '50000000-0000-0000-0000-000000000101') = 1,
  'an admin can see any document request'
);

-- =============================================================================
-- 8. document_data_student_attendance inherits attendance_records RLS scope
--    (docs/22 ADR-015): the student themself can fetch their own data.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- student.rahul

select ok(
  (select count(*) from public.document_data_student_attendance('20000000-0000-0000-0000-000000000701')) = 1,
  'a student can fetch their own attendance merge data'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000007'); -- student.priya, unrelated

select is(
  (select count(*) from public.document_data_student_attendance('20000000-0000-0000-0000-000000000701'))::int,
  0,
  'a different student fetching another student''s attendance merge data gets zero rows'
);

-- =============================================================================
-- 9. Storage RLS: document-templates bucket is admin-write, documents.read-select.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs, holds documents.read, not admin

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner) values ('document-templates', 'templates/hod-upload.docx', '10000000-0000-0000-0000-000000000002') $$,
  '42501',
  null,
  'a non-admin cannot write into the document-templates bucket'
);

-- =============================================================================
-- 10. Storage RLS: generated-documents bucket is requester-folder-scoped.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- student.rahul

insert into storage.objects (bucket_id, name, owner)
values ('generated-documents', '10000000-0000-0000-0000-000000000006/cert.docx', '10000000-0000-0000-0000-000000000006');

select is(
  (select count(*) from storage.objects where bucket_id = 'generated-documents' and name = '10000000-0000-0000-0000-000000000006/cert.docx')::int,
  1,
  'a student can write into their own folder in generated-documents'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner) values ('generated-documents', '10000000-0000-0000-0000-000000000007/cert.docx', '10000000-0000-0000-0000-000000000006') $$,
  '42501',
  null,
  'a student cannot write into another user''s folder in generated-documents'
);

select * from finish();
rollback;
