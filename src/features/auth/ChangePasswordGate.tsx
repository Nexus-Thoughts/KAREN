/**
 * Forced first-login password change.
 *
 * Rendered by App.tsx in place of the routed application whenever
 * `profile.must_change_password` is true (set by an admin provisioning flow —
 * see supabase/migrations/20260101000800_auth_hardening.sql). Uses the same
 * glass-card visual language as LoginPage (itself ported from
 * reference/IRIS-PAYROLL-main/components/Login.tsx) rather than inventing a
 * new screen style for what is, structurally, still an auth step.
 */
import React, { useState } from 'react';
import { Lock, ArrowRight, AlertCircle, ShieldAlert } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from './AuthProvider';

const ChangePasswordGate: React.FC = () => {
  const { profile, isPasswordRecovery, clearPasswordRecovery, refreshProfile, signOut } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setSubmitting(false);
      setError(updateError.message);
      return;
    }

    // The two triggers for this screen clear differently: a forced first-login
    // change clears public.users.must_change_password through the dedicated
    // RPC (see its own comment for why a plain UPDATE can't do this); a
    // "forgot password" recovery-link flow has nothing to clear in the
    // database — must_change_password was never set for it — only the local
    // isPasswordRecovery flag that got this screen shown in the first place.
    if (profile?.must_change_password) {
      const { error: rpcError } = await supabase.rpc('complete_password_change');
      if (rpcError) {
        setSubmitting(false);
        setError(rpcError.message);
        return;
      }
    }
    clearPasswordRecovery();
    setSubmitting(false);
    await refreshProfile();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-main relative overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-status-warning/10 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-accent-primary/10 rounded-full blur-[100px] pointer-events-none" />

      <div className="w-full max-w-md p-8 bg-panel/80 backdrop-blur-xl border border-border-default rounded-2xl shadow-2xl relative z-10 animate-in fade-in zoom-in-95 duration-500">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-to-br from-status-warning to-accent-primary rounded-xl flex items-center justify-center mx-auto mb-4">
            <ShieldAlert className="text-white" size={28} />
          </div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">Set a New Password</h1>
          <p className="text-text-secondary mt-2 text-sm">
            {isPasswordRecovery
              ? 'Choose a new password to finish resetting your account.'
              : 'Your account was provisioned with a temporary password. Choose a new one to continue.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="p-3 bg-status-error/10 border border-status-error/20 rounded-lg flex items-center gap-2 text-status-error text-sm">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-muted uppercase ml-1">New Password</label>
            <div className="relative group">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted group-focus-within:text-accent-primary transition-colors" size={18} />
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-main border border-border-default rounded-xl py-3 pl-10 pr-4 text-text-primary outline-none focus:border-accent-primary transition-colors"
                placeholder="At least 8 characters"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-muted uppercase ml-1">Confirm Password</label>
            <div className="relative group">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted group-focus-within:text-accent-primary transition-colors" size={18} />
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full bg-main border border-border-default rounded-xl py-3 pl-10 pr-4 text-text-primary outline-none focus:border-accent-primary transition-colors"
                placeholder="••••••••"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-accent-primary hover:bg-accent-secondary text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-accent-primary/25 flex items-center justify-center gap-2 mt-4 hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100"
          >
            {submitting ? 'Saving…' : 'Set Password & Continue'} <ArrowRight size={18} />
          </button>
        </form>

        <button onClick={signOut} className="w-full text-center text-xs text-text-muted hover:text-text-primary mt-6">
          Sign out instead
        </button>
      </div>
    </div>
  );
};

export default ChangePasswordGate;
