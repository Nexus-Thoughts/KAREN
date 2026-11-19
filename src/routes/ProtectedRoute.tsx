/**
 * Route guard. This is a UI convenience — it stops an unauthenticated or
 * wrongly-scoped user from rendering a screen they will get empty/denied
 * data for anyway. It is explicitly NOT the security boundary: RLS
 * (supabase/migrations/20260101000700_rls_policies.sql) is, per
 * docs/13_SECURITY_AND_PRIVACY.md ("frontend hiding is not security"). Every
 * query this route's children issue is independently authorized by Postgres.
 */
import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthProvider';
import ChangePasswordGate from '@/features/auth/ChangePasswordGate';
import { hasRole, primaryRole, type RoleKey } from '@/types/domain';

export const RequireAuth: React.FC = () => {
  const { status, profile, isPasswordRecovery } = useAuth();

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-main text-text-secondary text-sm">
        Loading session…
      </div>
    );
  }

  if (status === 'signed_out' || !profile) {
    return <Navigate to="/login" replace />;
  }

  // Every routed screen sits behind this one guard, so this is the single
  // place a forced password change (admin-provisioned account) or an
  // in-progress "forgot password" recovery link needs to intercept
  // navigation — no individual route can be reached (by URL or otherwise)
  // while either is pending.
  if (profile.must_change_password || isPasswordRecovery) {
    return <ChangePasswordGate />;
  }

  return <Outlet />;
};

/** Restricts a route subtree to one or more roles; redirects elsewhere otherwise. */
export const RequireRole: React.FC<{ roles: RoleKey[] }> = ({ roles }) => {
  const { profile } = useAuth();
  if (!profile) return <Navigate to="/login" replace />;

  const allowed = roles.some((r) => hasRole(profile, r));
  if (!allowed) {
    const home = primaryRole(profile);
    return <Navigate to={home ? `/${home.toLowerCase().replace('_', '-')}/dashboard` : '/login'} replace />;
  }

  return <Outlet />;
};
