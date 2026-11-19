-- =============================================================================
-- 20260101000500_role_assignments
-- Phase 4 — binding users to roles, with scope.
--
-- A user may hold several role assignments at once. The same person is
-- routinely FACULTY (for their subjects), MENTOR (for their mentees) and
-- CLASS_INCHARGE (for one section). Modelling this as a set of scoped
-- assignments, rather than a single `role` column, is what makes that
-- expressible without special cases.
--
-- docs/04_RBAC_AND_PERMISSIONS.md
-- =============================================================================

create table public.user_roles (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid        not null references public.users (id) on delete cascade,
  role_id       uuid        not null references public.roles (id) on delete restrict,

  -- Scope anchors. Which one applies is determined by the role's scope_kind
  -- and enforced by the check constraint below.
  department_id uuid        references public.departments (id) on delete cascade,
  section_id    uuid        references public.sections (id)    on delete cascade,

  granted_by    uuid        references public.users (id) on delete set null,
  granted_at    timestamptz not null default now(),
  -- Time-boxed assignments (an acting HOD, a semester-long in-charge).
  valid_from    timestamptz not null default now(),
  valid_until   timestamptz,

  status        public.entity_status not null default 'ACTIVE',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint user_roles_validity check (valid_until is null or valid_until > valid_from)
);

comment on table public.user_roles is
  'Scoped role assignments. A user may hold several. Every RLS policy resolves reach through this table, never through a role column on users.';

-- Scope shape must match the role. An ADMIN assignment carrying a department,
-- or an HOD assignment carrying none, is rejected by the database rather than
-- being left to application validation.
create or replace function cims.validate_role_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scope public.scope_kind;
  v_key   public.role_key;
begin
  select default_scope, key into v_scope, v_key
  from public.roles where id = new.role_id;

  case v_scope
    when 'GLOBAL' then
      if new.department_id is not null or new.section_id is not null then
        raise exception 'Role % has GLOBAL scope and must not carry a department or section', v_key
          using errcode = '23514';
      end if;

    when 'DEPARTMENT' then
      if new.department_id is null then
        raise exception 'Role % has DEPARTMENT scope and requires department_id', v_key
          using errcode = '23514';
      end if;
      if new.section_id is not null then
        raise exception 'Role % has DEPARTMENT scope and must not carry a section', v_key
          using errcode = '23514';
      end if;

    when 'SECTION' then
      if new.section_id is null then
        raise exception 'Role % has SECTION scope and requires section_id', v_key
          using errcode = '23514';
      end if;
      -- Keep department_id consistent with the section so department-level
      -- queries do not have to join through sections.
      select s.department_id into new.department_id
      from public.sections s where s.id = new.section_id;

    when 'ASSIGNED' then
      if new.section_id is not null then
        raise exception 'Role % derives reach from assignment tables and must not carry a section', v_key
          using errcode = '23514';
      end if;

    when 'SELF' then
      if new.department_id is not null or new.section_id is not null then
        raise exception 'Role % has SELF scope and must not carry a department or section', v_key
          using errcode = '23514';
      end if;
  end case;

  return new;
end;
$$;

create trigger user_roles_validate_scope
  before insert or update on public.user_roles
  for each row execute function cims.validate_role_scope();

-- One live assignment per (user, role, scope). Partial unique indexes because
-- NULL scope columns must still collide.
create unique index user_roles_unique_global_idx
  on public.user_roles (user_id, role_id)
  where status = 'ACTIVE' and department_id is null and section_id is null;

create unique index user_roles_unique_dept_idx
  on public.user_roles (user_id, role_id, department_id)
  where status = 'ACTIVE' and department_id is not null and section_id is null;

create unique index user_roles_unique_section_idx
  on public.user_roles (user_id, role_id, section_id)
  where status = 'ACTIVE' and section_id is not null;

create index user_roles_user_idx       on public.user_roles (user_id) where status = 'ACTIVE';
create index user_roles_role_idx       on public.user_roles (role_id);
create index user_roles_department_idx on public.user_roles (department_id) where department_id is not null;
create index user_roles_section_idx    on public.user_roles (section_id)    where section_id is not null;

create trigger user_roles_set_updated_at before update on public.user_roles
  for each row execute function cims.set_updated_at();

-- Role grants and revocations are always audited (docs/49).
create trigger user_roles_audit
  after insert or update or delete on public.user_roles
  for each row execute function cims.audit_row_change();

alter table public.user_roles enable row level security;
