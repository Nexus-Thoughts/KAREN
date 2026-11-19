/**
 * KAREN domain types.
 *
 * These are the frontend-facing shapes returned by `public.my_profile()` and
 * the REST/RPC layer — the KAREN analogue of IRIS's `types.ts` `User` /
 * `ViewState`. Table-shaped types (rows/inserts/updates) come from the
 * generated `src/types/database.ts` (via `npm run db:types`) once the local
 * Supabase stack has run; these are hand-written because they describe
 * *derived* shapes (RPC results, session state), not raw table rows.
 */

export type RoleKey =
  | 'ADMIN'
  | 'HOD'
  | 'FACULTY'
  | 'MENTOR'
  | 'CLASS_INCHARGE'
  | 'STUDENT';

export type ScopeKind = 'GLOBAL' | 'DEPARTMENT' | 'SECTION' | 'ASSIGNED' | 'SELF';

export interface RoleAssignment {
  role: RoleKey;
  scope: ScopeKind;
  department_id: string | null;
  section_id: string | null;
}

/** Mirrors public.my_profile()'s JSON shape exactly — see supabase/migrations/20260101000800_auth_hardening.sql */
export interface SessionProfile {
  user_id: string;
  email: string | null;
  full_name: string;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  /** True for an administrator-provisioned account that has not yet set its own password. See src/features/auth/ChangePasswordGate.tsx. */
  must_change_password: boolean;
  student_id: string | null;
  faculty_id: string | null;
  roles: RoleAssignment[];
  permissions: string[];
}

/**
 * The role used to pick which navigation/dashboard a signed-in user sees when
 * they hold several. Mirrors `roles.rank` in the database (lower binds
 * tighter): ADMIN > HOD > CLASS_INCHARGE > MENTOR > FACULTY > STUDENT.
 */
const ROLE_RANK: Record<RoleKey, number> = {
  ADMIN: 10,
  HOD: 20,
  CLASS_INCHARGE: 30,
  MENTOR: 40,
  FACULTY: 50,
  STUDENT: 60,
};

export function primaryRole(profile: SessionProfile): RoleKey | null {
  if (profile.roles.length === 0) return null;
  return [...profile.roles].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role])[0]!.role;
}

export function hasPermission(profile: SessionProfile | null, key: string): boolean {
  return profile?.permissions.includes(key) ?? false;
}

export function hasRole(profile: SessionProfile | null, role: RoleKey): boolean {
  return profile?.roles.some((r) => r.role === role) ?? false;
}

/** Route-segment identifiers for the role-scoped navigation, replacing IRIS's ViewState. */
export type NavId =
  | 'dashboard'
  | 'students'
  | 'faculty'
  | 'departments'
  | 'timetable'
  | 'classrooms'
  | 'geofencing'
  | 'attendance'
  | 'notifications'
  | 'reports'
  | 'documents'
  | 'karen'
  | 'settings'
  | 'audit'
  | 'my-attendance'
  | 'my-timetable';

export interface NavItem {
  id: NavId;
  label: string;
  icon: string; // lucide-react icon name, resolved by the shell
}
