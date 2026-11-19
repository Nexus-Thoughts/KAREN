import React from 'react';
import { Outlet } from 'react-router-dom';
import Layout from '@/components/shell/Layout';
import { useAuth } from '@/features/auth/AuthProvider';

/** Wraps every role-scoped route subtree in the ported IRIS Layout shell. */
const RoleShell: React.FC = () => {
  const { profile, signOut } = useAuth();
  if (!profile) return null;

  return (
    <Layout profile={profile} onLogout={signOut}>
      <Outlet />
    </Layout>
  );
};

export default RoleShell;
