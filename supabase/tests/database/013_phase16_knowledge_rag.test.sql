-- =============================================================================
-- 013_phase16_knowledge_rag.test.sql
--
-- Covers supabase/migrations/20260101002400_karen_knowledge_rag.sql: the
-- ADMIN-only write path, RLS read reach for any active user, the
-- is-indexed/not-yet-indexed distinction, and that match_knowledge_chunks
-- actually orders by vector similarity rather than just returning rows.
--
-- Run (with all the others) with `supabase test db` after `supabase db
-- reset`. Synthetic embeddings only (all-same-value vectors of the fixed
-- 768 dimension) — no real Gemini call happens in this suite, matching
-- docs/00 §15's synthetic-fixtures-only rule; the reindex script
-- (scripts/reindex-knowledge.mjs) is what talks to Gemini, and only when a
-- human runs it deliberately.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(9);

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

-- Small helper: an all-`n` 768-dim vector literal, so two calls with the
-- same n are identical vectors (similarity 1.0) and different n values are
-- reliably different vectors (similarity < 1.0) without depending on a real
-- embedding model.
create or replace function tests.fixed_vector(n numeric)
returns extensions.vector
language sql
as $$
  select ('[' || array_to_string(array(select n from generate_series(1, 768)), ',') || ']')::extensions.vector(768)
$$;

reset role;
select set_config('request.jwt.claims', '', true);

-- =============================================================================
-- 1. Nothing indexed yet: karen_knowledge_is_indexed() is false.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- rahul, a plain student

select ok(
  not public.karen_knowledge_is_indexed(),
  'karen_knowledge_is_indexed() is false before anything is embedded'
);

-- =============================================================================
-- 2. A student cannot write a knowledge chunk (ADMIN-only).
-- =============================================================================
select throws_ok(
  $$ select public.karen_admin_upsert_knowledge_chunk('docs/x.md', 'X', 0, 'not admin') $$,
  -- Cast length matters: bare `::character` is `character(1)` and silently
  -- truncates a 5-char SQLSTATE to its first character, which then fails to
  -- match the real code even though the right exception was thrown.
  '42501'::character(5),
  null,
  'a student cannot call karen_admin_upsert_knowledge_chunk'
);

-- =============================================================================
-- 3. Admin writes two chunks from two documents; is_indexed flips true.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

select lives_ok(
  $$ select public.karen_admin_upsert_knowledge_chunk(
       'docs/09_ai_tools.md', 'AI Tools and Agents', 0,
       'KAREN never fabricates institutional data.', tests.fixed_vector(0.01)
     ) $$,
  'admin can write a knowledge chunk with an embedding'
);

select lives_ok(
  $$ select public.karen_admin_upsert_knowledge_chunk(
       'docs/13_security.md', 'Security and Privacy', 0,
       'Frontend hiding is not security.', tests.fixed_vector(0.90)
     ) $$,
  'admin can write a second chunk from a different document'
);

select ok(
  public.karen_knowledge_is_indexed(),
  'karen_knowledge_is_indexed() is true once a chunk has an embedding'
);

-- =============================================================================
-- 4. Re-running the same source_path/chunk_index upserts rather than
--    duplicating (the reindex script's idempotency, on conflict do update).
-- =============================================================================
select public.karen_admin_upsert_knowledge_chunk(
  'docs/09_ai_tools.md', 'AI Tools and Agents (revised)', 0,
  'KAREN never fabricates institutional data. Revised wording.', tests.fixed_vector(0.01)
);

select is(
  (select count(*)::int from public.karen_knowledge_documents where source_path = 'docs/09_ai_tools.md'),
  1,
  're-upserting the same source_path/chunk_index updates in place, not duplicates'
);

-- =============================================================================
-- 5. match_knowledge_chunks orders by actual cosine similarity: querying
--    with a vector close to chunk A's embedding returns A ahead of B.
-- =============================================================================
select is(
  (select document_title from public.match_knowledge_chunks(tests.fixed_vector(0.011), 2) limit 1),
  'AI Tools and Agents (revised)',
  'match_knowledge_chunks ranks the closer embedding first'
);

-- =============================================================================
-- 6. A student (any active user, not just admin) can read via RLS.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006');

select is(
  (select count(*)::int from public.karen_knowledge_chunks),
  2,
  'a student can read indexed knowledge chunks (institutional, not personal, data)'
);

select is(
  (select count(*)::int from public.match_knowledge_chunks(tests.fixed_vector(0.01), 5)),
  2,
  'a student can call match_knowledge_chunks and see both chunks (SECURITY INVOKER + RLS)'
);

select * from finish();
rollback;
