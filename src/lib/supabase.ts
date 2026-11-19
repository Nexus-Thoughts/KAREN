import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * The single Supabase client for the browser. Uses only the anon key — RLS
 * (supabase/migrations/20260101000700_rls_policies.sql) is what actually
 * restricts access, per docs/13_SECURITY_AND_PRIVACY.md ("frontend hiding is
 * not security"). The service-role key never appears in frontend code; it is
 * used only by Edge Functions and CI, read from a non-VITE_-prefixed
 * environment variable so Vite cannot inline it into the bundle.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
// Supabase's newer projects issue `sb_publishable_...` keys instead of an
// anon JWT (the local CLI stack still uses the JWT form). Both are accepted
// so the same client code works whichever project VITE_SUPABASE_URL points
// at, without a branch anywhere else in the app.
const publishableKey =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ??
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);

if (!url || !publishableKey) {
  // Fail loudly rather than silently falling back to a mock client — a
  // missing config value should never present as "everything is empty."
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY) must be set. Copy .env.example to .env and run `npm run db:start`.'
  );
}

export const supabase = createClient<Database>(url, publishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
