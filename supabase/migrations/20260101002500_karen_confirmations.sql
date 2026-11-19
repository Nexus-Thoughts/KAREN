-- =============================================================================
-- 20260101002500_karen_confirmations
-- Phase 17 — KAREN confirmations for write actions.
--
-- docs/09_AI_TOOLS_AND_AGENTS.md's write tools (generate_report,
-- generate_document) stayed NOT_IMPLEMENTED through Phase 15 specifically
-- because no confirmation step existed yet — an AI agent must never
-- mutate data on its own say-so mid-conversation (docs/08 "no autonomous
-- writes without confirmation"). This migration adds the generic mechanism
-- any write tool can use, and wires up the first real one: notify_student.
--
-- Protocol (see supabase/functions/karen-chat/index.ts /
-- src/features/karen/KarenChatPage.tsx for the two call sites):
--   1. A tool with requiresConfirmation=true (tools.ts) doesn't execute on
--      its first call — it inserts a karen_pending_actions row describing
--      exactly what it would do, and returns that row's id + a
--      human-readable summary instead of a result.
--   2. The chat UI renders a Confirm/Cancel affordance from that summary.
--   3. Confirming re-invokes karen-chat with { confirmActionId }. The
--      Edge Function looks the row up (still scoped to the same user via
--      RLS below — no cross-user or cross-conversation replay), checks it
--      is unconsumed and unexpired, then actually runs the tool.
-- A pending action nobody confirms simply expires; nothing happens.
-- =============================================================================

create table public.karen_pending_actions (
  id               uuid primary key default extensions.gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  conversation_id  uuid not null references public.karen_conversations (id) on delete cascade,
  tool_name        text not null,
  args             jsonb not null,
  summary          text not null,
  created_at       timestamptz not null default now(),
  -- Short-lived on purpose: a stale "yes, notify them" confirmed minutes
  -- after the surrounding conversation moved on is a worse experience (and
  -- a bigger surprise-mutation risk) than asking the user to re-request it.
  expires_at       timestamptz not null default now() + interval '10 minutes',
  consumed_at      timestamptz
);

create index karen_pending_actions_user_idx on public.karen_pending_actions (user_id, created_at desc);

alter table public.karen_pending_actions enable row level security;

create policy karen_pending_actions_own on public.karen_pending_actions
  for all to authenticated
  using (cims.is_active_user() and user_id = cims.current_user_id())
  with check (cims.is_active_user() and user_id = cims.current_user_id());

grant select, insert, update on public.karen_pending_actions to authenticated;

comment on table public.karen_pending_actions is
  'A write tool KAREN proposed but has not executed. Confirmed or expired, never edited in place (the Edge Function inserts once, updates only consumed_at once) — see karen-chat/index.ts.';

-- -----------------------------------------------------------------------------
-- notify_student — the first real KAREN write action (docs/09's
-- generate_report/generate_document stay NOT_IMPLEMENTED; this is a
-- narrower, safer first write to wire the confirmation protocol through).
--
-- Re-derives students_select_scoped's own reachability predicate
-- (20260101000700_rls_policies.sql) rather than trusting the caller: this
-- function is SECURITY DEFINER (it must be, to call cims.enqueue_notification,
-- itself SECURITY DEFINER and cims-private), so RLS on `students` does not
-- apply inside it automatically. The tool layer (tools.ts) already checked
-- reachability once through the caller's own RLS-scoped client before
-- proposing the action; this is the defense-in-depth second check so the
-- guarantee holds even if this RPC is ever called directly, matching the
-- "old and new row must both be in scope" pattern already used elsewhere in
-- this schema (e.g. students_update_scoped).
-- -----------------------------------------------------------------------------
create or replace function public.karen_send_notification(
  p_student_id uuid,
  p_title      text,
  p_message    text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_recipient_user_id uuid;
  v_notification_id   uuid;
begin
  if not cims.is_active_user() then
    raise exception 'inactive user' using errcode = '42501';
  end if;

  select user_id into v_recipient_user_id
  from public.students s
  where s.id = p_student_id
    and (
      s.user_id = auth.uid()
      or (cims.has_permission('students.read') and s.id in (select cims.my_student_ids()))
    );

  if v_recipient_user_id is null then
    raise exception 'no such student, or not within your reach' using errcode = '42501';
  end if;

  v_notification_id := cims.enqueue_notification(
    v_recipient_user_id, 'ADMINISTRATIVE', p_title, p_message,
    'karen_message', null, null
  );

  return v_notification_id;
end;
$$;

comment on function public.karen_send_notification is
  'The only write karen_pending_actions currently unlocks. Re-checks student reachability itself (SECURITY DEFINER bypasses RLS) rather than trusting the caller — see comment above.';

grant execute on function public.karen_send_notification(uuid, text, text) to authenticated;
