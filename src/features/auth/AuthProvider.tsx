import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { SessionProfile } from '@/types/domain';

/**
 * Production replacement for IRIS's `authenticateUser()`
 * (reference/IRIS-PAYROLL-main/services/dataService.ts), which compared a
 * plaintext password against a hard-coded array and returned a role string
 * with no session at all.
 *
 * Here, Supabase Auth owns the credential and the session; this provider's
 * job is only to load the *authorisation* projection — profile, scoped role
 * assignments and effective permissions — via the `my_profile()` RPC
 * (supabase/migrations/20260101000600_authorization_functions.sql), which is
 * backed by RLS-safe SECURITY DEFINER functions, not a client-side guess.
 *
 * `profile` is null while a session exists but the RPC hasn't resolved yet;
 * consumers should treat `status === 'loading'` as "don't render role-gated
 * UI yet", not "not authenticated" — see docs/13 on frontend hiding not being
 * security regardless.
 */

type AuthStatus = 'loading' | 'signed_out' | 'signed_in';

interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  profile: SessionProfile | null;
  error: string | null;
  /**
   * True from the moment Supabase's SDK reports a `PASSWORD_RECOVERY` event
   * (the user followed a "forgot password" email link) until they set a new
   * password. `detectSessionInUrl: true` (src/lib/supabase.ts) means the
   * recovery link's token silently establishes a normal-looking session on
   * its own — without tracking this separately, a user who clicked "forgot
   * password" would land straight in the app having never actually changed
   * anything.
   */
  isPasswordRecovery: boolean;
  /** Called once the recovery-flow password has actually been changed. */
  clearPasswordRecovery: () => void;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  const loadProfile = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('my_profile');
    if (rpcError) {
      // A failed profile fetch must not silently grant a blank (unscoped)
      // session — treat it as signed out rather than rendering with profile=null
      // in a state that looks authenticated.
      setError(rpcError.message);
      setProfile(null);
      return;
    }
    setProfile(data as unknown as SessionProfile);
    setError(null);
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      if (data.session) {
        loadProfile().finally(() => mounted && setStatus('signed_in'));
      } else {
        setStatus('signed_out');
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') setIsPasswordRecovery(true);

      setSession(nextSession);
      if (nextSession) {
        setStatus('loading');
        loadProfile().finally(() => setStatus('signed_in'));
      } else {
        setProfile(null);
        setStatus('signed_out');
      }
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      // Deliberately generic message: do not confirm whether the account
      // exists (docs/13 — least privilege, no unnecessary information disclosure).
      const message = 'Invalid credentials.';
      setError(message);
      return { error: message };
    }
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setSession(null);
    setStatus('signed_out');
    setIsPasswordRecovery(false);
  }, []);

  const clearPasswordRecovery = useCallback(() => setIsPasswordRecovery(false), []);

  return (
    <AuthContext.Provider
      value={{
        status,
        session,
        profile,
        error,
        isPasswordRecovery,
        clearPasswordRecovery,
        signIn,
        signOut,
        refreshProfile: loadProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
