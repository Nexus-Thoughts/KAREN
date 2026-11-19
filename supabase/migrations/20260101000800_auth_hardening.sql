-- =============================================================================
-- 20260101000800_auth_hardening
-- College-issued credentials, forced first-login password change, and a
-- column-level self-update gap this surfaced in public.users.
--
-- docs/13_SECURITY_AND_PRIVACY.md
-- =============================================================================

alter table public.users
  add column must_change_password boolean not null default false;

comment on column public.users.must_change_password is
  'Set true when an administrator provisions an account with an initial password. The forced-change gate (src/features/auth/ChangePasswordGate.tsx) blocks the app until the user sets their own password and this clears via public.complete_password_change().';

-- -----------------------------------------------------------------------------
-- Column-level self-edit restriction.
--
-- `users_update_self` (20260101000700) is row-scoped only: `id = auth.uid()`.
-- RLS in Postgres is row-level, not column-level — that policy does not, and
-- cannot by itself, stop a signed-in user from writing ANY column on their
-- own row, including `status`. Concretely: an administrator sets a user's
-- status to SUSPENDED, and without this trigger the suspended user could
-- UPDATE their own row back to ACTIVE and undo it, since users_update_self's
-- WITH CHECK only re-checks `id = auth.uid()`, which still holds.
--
-- Column-level GRANT can't fix this either: self-edits and admin edits both
-- execute as the same Postgres role (`authenticated` — KAREN has no separate
-- DB role per user), so a column grant can't distinguish "editing your own
-- row without users.write" from "an admin editing any row". A trigger can,
-- because it sees both the acting user and the specific row being touched.
-- -----------------------------------------------------------------------------
create or replace function cims.restrict_self_user_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- No session context at all (auth.uid() is null) means this UPDATE did not
  -- arrive through PostgREST/a user JWT — it's `postgres` running a migration
  -- or `supabase db reset`'s seed.sql directly. Confirmed by the very first
  -- `db reset` after this migration landed: the seed's own
  -- `update public.users set must_change_password = true ...` for the dev
  -- fixture account failed with "Not authorised to modify this user", because
  -- has_permission('users.write') is also false with no session (no
  -- user_roles row exists for a null user). RLS already isn't in play for a
  -- table-owner connection; this trigger must not re-impose it there either.
  if auth.uid() is null then
    return new;
  end if;

  -- Admins (or anyone else holding users.write) are unrestricted here;
  -- RLS's users_write_admin policy already gates that they reached this row.
  if cims.has_permission('users.write') then
    return new;
  end if;

  -- Not a self-edit and not a privileged editor: users_update_self's own
  -- USING clause should already have excluded this row, but fail closed.
  if new.id is distinct from auth.uid() then
    raise exception 'Not authorised to modify this user' using errcode = '42501';
  end if;

  -- Self-edit allowlist: full_name and phone. Everything else reverts to the
  -- stored value regardless of what the client sent, rather than erroring —
  -- an UPDATE that only touches an editable field plus an unrelated
  -- unchanged column should not fail.
  new.status     := old.status;
  new.email      := old.email;
  new.created_at := old.created_at;

  -- must_change_password only ever moves true -> false, and only through
  -- public.complete_password_change(). That function runs as this same
  -- non-privileged caller (SECURITY DEFINER changes table privileges, not
  -- auth.uid()), so without an explicit signal this trigger cannot tell its
  -- UPDATE apart from an arbitrary client one and would silently revert the
  -- very change it exists to make. complete_password_change() sets this
  -- transaction-local GUC immediately before its UPDATE as that signal.
  if coalesce(current_setting('cims.allow_password_change_clear', true), '') <> 'true' then
    new.must_change_password := old.must_change_password;
  end if;

  return new;
end;
$$;

comment on function cims.restrict_self_user_update is
  'BEFORE UPDATE on public.users. Confines a non-privileged self-edit to full_name/phone; every other column snaps back to its stored value.';

create trigger users_restrict_self_update
  before update on public.users
  for each row execute function cims.restrict_self_user_update();

-- -----------------------------------------------------------------------------
-- public.complete_password_change()
--
-- Called by the client immediately after `supabase.auth.updateUser({password})`
-- succeeds. Clearing must_change_password is intentionally NOT something the
-- trigger above allows through a plain UPDATE — routing it through one
-- narrow, audited RPC means "the flag cleared" and "the user actually changed
-- their password" cannot drift apart.
-- -----------------------------------------------------------------------------
create or replace function public.complete_password_change()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('cims.allow_password_change_clear', 'true', true);
  update public.users set must_change_password = false where id = auth.uid();
  perform cims.write_audit('UPDATE', 'users', auth.uid()::text, null,
    jsonb_build_object('must_change_password', jsonb_build_object('from', true, 'to', false)),
    'first-login forced password change completed');
end;
$$;

grant execute on function public.complete_password_change() to authenticated;

-- my_profile() must surface the flag or the frontend gate has nothing to key on.
create or replace function public.my_profile()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'user_id',    u.id,
    'email',      u.email,
    'full_name',  u.full_name,
    'status',     u.status,
    'must_change_password', u.must_change_password,
    'student_id', cims.my_student_id(),
    'faculty_id', cims.my_faculty_id(),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role',          ra.role_key,
        'scope',         ra.scope_kind,
        'department_id', ra.department_id,
        'section_id',    ra.section_id
      ) order by ra.role_key)
      from cims.my_role_assignments() ra
    ), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(mp.permission_key order by mp.permission_key)
      from public.my_permissions() mp
    ), '[]'::jsonb)
  )
  from public.users u
  where u.id = auth.uid();
$$;
