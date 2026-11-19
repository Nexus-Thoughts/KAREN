-- =============================================================================
-- 20260101002400_karen_knowledge_rag
-- Phase 16 — KAREN RAG (retrieval-augmented generation).
--
-- docs/09_AI_TOOLS_AND_AGENTS.md lists `search_knowledge` as one of KAREN's
-- fixed 14 tools; until now it returned a typed NOT_IMPLEMENTED result
-- (supabase/functions/karen-chat/tools.ts) because no document corpus or
-- vector index existed. This migration adds both, seeded with CIMS's own
-- docs/ folder — the one corpus that is unambiguously real, already
-- reviewed, and institutionally appropriate for KAREN to quote from (no
-- fabricated or placeholder "knowledge base" content, matching docs/08's
-- "no fabricated values" rule applied to what KAREN is allowed to cite, not
-- just to live data).
--
-- Embeddings are computed OUTSIDE the request path, by an operator running
-- `npm run karen:reindex` (scripts/reindex-knowledge.mjs) after deploying —
-- never inline during a chat turn, matching ADR-004 (no long-running work
-- inside karen-chat's request/response cycle) and letting `embedding` stay
-- NULL immediately after this migration runs without breaking anything:
-- match_knowledge_chunks simply excludes not-yet-embedded rows.
-- =============================================================================

-- text-embedding-004 (Gemini's embedding model, matching KAREN's chat
-- provider — docs/00, the user's explicit choice of Gemini) outputs 768
-- dimensions. Fixed here, not inferred, so a dimension mismatch from a
-- future different embedding model fails fast at insert time instead of
-- silently corrupting cosine-distance search.
create table public.karen_knowledge_documents (
  id           uuid primary key default extensions.gen_random_uuid(),
  title        text not null,
  -- Repo-relative path (e.g. 'docs/09_AI_TOOLS_AND_AGENTS.md') — the
  -- natural stable key for re-running the reindex script idempotently.
  source_path  text not null unique,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger karen_knowledge_documents_set_updated_at before update on public.karen_knowledge_documents
  for each row execute function cims.set_updated_at();

create table public.karen_knowledge_chunks (
  id            uuid primary key default extensions.gen_random_uuid(),
  document_id   uuid not null references public.karen_knowledge_documents (id) on delete cascade,
  chunk_index   integer not null,
  content       text not null,
  -- NULL until the reindex script embeds it (see migration header). A tool
  -- call against an unindexed knowledge base must say so, not silently
  -- return zero results indistinguishable from "no matches" (docs/08 "no
  -- fabricated values" extends to not fabricating false confidence either).
  embedding     extensions.vector(768),
  created_at    timestamptz not null default now(),

  constraint karen_knowledge_chunks_unique unique (document_id, chunk_index)
);

-- HNSW over cosine distance: the standard choice for pgvector similarity
-- search at this scale (a few hundred chunks from docs/, not millions of
-- rows) — no tuning (lists/probes) required unlike IVFFlat, and correct
-- from the first row onward instead of needing a minimum table size first.
create index karen_knowledge_chunks_embedding_idx on public.karen_knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create index karen_knowledge_chunks_document_idx on public.karen_knowledge_chunks (document_id);

alter table public.karen_knowledge_documents enable row level security;
alter table public.karen_knowledge_chunks enable row level security;

-- Institutional documentation, not personal data — every active user may
-- read it (same reach as the rest of the app's non-personal reference
-- data), but only ever through the admin-gated write path below, never a
-- direct PostgREST insert/update/delete (docs/13: KAREN's own storage gets
-- least privilege too, not just the tables it queries).
create policy karen_knowledge_documents_select on public.karen_knowledge_documents
  for select to authenticated using (cims.is_active_user());

create policy karen_knowledge_chunks_select on public.karen_knowledge_chunks
  for select to authenticated using (cims.is_active_user());

grant select on public.karen_knowledge_documents, public.karen_knowledge_chunks to authenticated;

-- -----------------------------------------------------------------------------
-- Admin-only upsert, called by scripts/reindex-knowledge.mjs once per chunk.
-- SECURITY DEFINER so the reindex script can run as an authenticated admin
-- (never the service role — ADR-004 applies to tooling too, not only to the
-- Edge Function) without needing a direct INSERT grant on these tables.
-- -----------------------------------------------------------------------------
create or replace function public.karen_admin_upsert_knowledge_chunk(
  p_source_path text,
  p_title       text,
  p_chunk_index integer,
  p_content     text,
  p_embedding   extensions.vector(768) default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_document_id uuid;
  v_chunk_id    uuid;
begin
  if not cims.is_admin() then
    raise exception 'karen_admin_upsert_knowledge_chunk requires ADMIN' using errcode = '42501';
  end if;

  insert into public.karen_knowledge_documents (title, source_path)
  values (p_title, p_source_path)
  on conflict (source_path) do update set title = excluded.title
  returning id into v_document_id;

  insert into public.karen_knowledge_chunks (document_id, chunk_index, content, embedding)
  values (v_document_id, p_chunk_index, p_content, p_embedding)
  on conflict (document_id, chunk_index)
    do update set content = excluded.content, embedding = excluded.embedding
  returning id into v_chunk_id;

  perform cims.write_audit(
    'UPDATE'::public.audit_action, 'karen_knowledge_chunk', v_chunk_id::text,
    null, jsonb_build_object('source_path', p_source_path, 'chunk_index', p_chunk_index)
  );

  return v_chunk_id;
end;
$$;

comment on function public.karen_admin_upsert_knowledge_chunk is
  'Only path that writes karen_knowledge_documents/chunks. ADMIN-gated so an unprivileged authenticated session cannot poison what KAREN cites as institutional knowledge.';

grant execute on function public.karen_admin_upsert_knowledge_chunk(text, text, integer, text, extensions.vector) to authenticated;

-- -----------------------------------------------------------------------------
-- match_knowledge_chunks — SECURITY INVOKER (subject to the two SELECT
-- policies above, same as any other RLS-scoped read in this codebase) so it
-- can never surface more than an active user could already see by directly
-- querying the tables. Excludes not-yet-embedded rows explicitly rather
-- than letting `embedding <=> query` silently sort NULLs in/out in a way
-- callers would have to guess at.
-- -----------------------------------------------------------------------------
create or replace function public.match_knowledge_chunks(
  p_query_embedding extensions.vector(768),
  p_match_count integer default 5
)
returns table (
  chunk_id      uuid,
  document_title text,
  source_path   text,
  content       text,
  similarity    real
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select
    c.id,
    d.title,
    d.source_path,
    c.content,
    (1 - (c.embedding <=> p_query_embedding))::real as similarity
  from public.karen_knowledge_chunks c
  join public.karen_knowledge_documents d on d.id = c.document_id
  where c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit greatest(p_match_count, 1);
$$;

comment on function public.match_knowledge_chunks is
  'SECURITY INVOKER — relies on karen_knowledge_chunks_select/karen_knowledge_documents_select RLS. Returns [] (not an error) when no chunk is embedded yet; callers (karen-chat''s search_knowledge tool) distinguish that from a real empty result via a separate count check.';

grant execute on function public.match_knowledge_chunks(extensions.vector, integer) to authenticated;

-- Cheap existence check the search_knowledge tool uses to tell "nothing
-- indexed yet" apart from "indexed, but nothing matched this query" — the
-- distinction docs/08's "no fabricated confidence" rule cares about.
create or replace function public.karen_knowledge_is_indexed()
returns boolean
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select exists (select 1 from public.karen_knowledge_chunks where embedding is not null);
$$;

grant execute on function public.karen_knowledge_is_indexed() to authenticated;
