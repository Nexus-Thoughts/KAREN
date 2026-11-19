/**
 * Adapted from reference/IRIS-PAYROLL-main/components/Login.tsx.
 *
 * The visual shell — background orbs, glass card, icon-prefixed inputs,
 * gradient logo tile, gradient submit button — is preserved unchanged
 * (docs/18 Rule 2–3). What changed:
 *
 *   1. `authenticateUser()` (plaintext array comparison) is replaced by
 *      `useAuth().signIn()`, which calls Supabase Auth
 *      (src/features/auth/AuthProvider.tsx). No credential ever touches
 *      application code in cleartext beyond the single password input.
 *   2. The block of hard-coded demo credentials printed under the form is
 *      removed outright — shipping working passwords on the login screen is
 *      exactly what docs/13_SECURITY_AND_PRIVACY.md exists to prevent, and
 *      it is not IRIS "design", it is an IRIS defect (docs/00 §15).
 *   3. Branding text changed from "IRIS Portal / Enterprise Payroll &
 *      Compliance System" to KAREN's own name, per docs/12 ("only page
 *      content, labels, domain data ... changes").
 */
import React, { useState } from 'react';
import { Lock, User as UserIcon, ArrowRight, AlertCircle, ShieldCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from './AuthProvider';
import ChangePasswordGate from './ChangePasswordGate';

const LoginPage: React.FC = () => {
  const { signIn, isPasswordRecovery } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResetSent(false);
    setSubmitting(true);
    const { error: signInError } = await signIn(email, password);
    setSubmitting(false);
    if (signInError) setError(signInError);
  };

  // Deliberately identical wording and identical `resetSent` outcome whether
  // or not `email` belongs to a real account — the account-enumeration rule
  // this login form already follows for bad credentials (docs/13, and the
  // module header below) applies just as much to "does this email exist".
  const handleForgotPassword = async () => {
    if (!email) {
      setError('Enter your User ID above first, then select "Forgot password".');
      return;
    }
    setError('');
    setResetting(true);
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    });
    setResetting(false);
    setResetSent(true);
  };

  // The "forgot password" email link redirects here with a recovery token in
  // the URL. `detectSessionInUrl: true` (src/lib/supabase.ts) consumes that
  // token and signs the browser in before this component even renders — at
  // that point AuthProvider's `isPasswordRecovery` is true, and what the user
  // actually needs is the password-setting screen, not this login form (which
  // they never got to submit) and not a route inside RequireAuth's tree
  // (`/login` sits outside it, so that guard's own recovery check never
  // reaches this session).
  if (isPasswordRecovery) {
    return <ChangePasswordGate />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-main relative overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-accent-primary/10 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-accent-secondary/10 rounded-full blur-[100px] pointer-events-none" />

      <div className="w-full max-w-md p-8 bg-panel/80 backdrop-blur-xl border border-border-default rounded-2xl shadow-2xl relative z-10 animate-in fade-in zoom-in-95 duration-500">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-to-br from-accent-primary to-accent-secondary rounded-xl flex items-center justify-center mx-auto mb-4 shadow-[0_0_20px_rgba(47,91,255,0.3)]">
            <span className="text-white text-3xl font-bold">C</span>
          </div>
          <h1 className="text-3xl font-bold text-text-primary tracking-tight">KAREN</h1>
          <p className="text-text-secondary mt-2 text-sm">College Management System</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="p-3 bg-status-error/10 border border-status-error/20 rounded-lg flex items-center gap-2 text-status-error text-sm">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {resetSent && (
            <div className="p-3 bg-status-info/10 border border-status-info/20 rounded-lg text-status-info text-sm">
              If that User ID matches an account, a password reset link has been sent to it.
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-muted uppercase ml-1">User ID</label>
            <div className="relative group">
              <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted group-focus-within:text-accent-primary transition-colors" size={18} />
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-main border border-border-default rounded-xl py-3 pl-10 pr-4 text-text-primary outline-none focus:border-accent-primary transition-colors"
                placeholder="you@college.edu"
              />
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex justify-between items-center ml-1">
              <label className="text-xs font-medium text-text-muted uppercase">Password</label>
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={resetting}
                className="text-xs text-accent-primary hover:underline disabled:opacity-50"
              >
                {resetting ? 'Sending…' : 'Forgot password?'}
              </button>
            </div>
            <div className="relative group">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted group-focus-within:text-accent-primary transition-colors" size={18} />
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
            {submitting ? 'Signing in…' : 'Sign In'} <ArrowRight size={18} />
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-border-default text-center">
          <p className="text-xs text-text-muted mb-2">Institutional Login</p>
          <div className="flex justify-center gap-4 text-xs text-text-secondary">
            <span className="flex items-center gap-1">
              <ShieldCheck size={12} /> Role-based access
            </span>
            <span className="flex items-center gap-1">
              <Lock size={12} /> Encrypted session
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
