# 23 — Local Development Setup

This environment has no Docker Desktop and no Supabase CLI on the Windows
side. Both were installed inside WSL2's Ubuntu distribution, which already
had a Docker daemon running (shared with an unrelated Coolify deployment on
this machine — the KAREN stack is additive, nothing about it was stopped or
reconfigured).

**Verified state as of Phase 4 completion:** `supabase db reset` applies all
7 migrations and `seed.sql` cleanly from empty; a real
`POST /auth/v1/token?grant_type=password` against a seeded account returns a
session; `public.my_profile()` returns the correct scoped payload over
`/rest/v1/rpc/my_profile`; the full pgTAP suite
(`supabase/tests/database/001_rbac_scope.test.sql`, 27 assertions covering
cross-role and cross-department isolation, expired-assignment behaviour and
audit hash-chain integrity) passes; `npm run typecheck`, `npm test` (13
assertions) and `npm run build` all pass against the generated
`src/types/database.ts`. Every defect this surfaced (missing `citext`
extension, the `auth.email.enable_signup` double meaning, missing
`email_change`/`email_change_token_new` seed values, missing base-table
`GRANT`s, an unsafe empty-string-to-jsonb cast in `cims.write_audit`) is
recorded in `docs/22_ARCHITECTURE_DECISIONS.md` ADR-006/007/008 and fixed at
the root, not worked around.

## One-time setup (already done in this environment)

```bash
wsl -e bash -lc "mkdir -p ~/.local/bin && curl -fsSL https://github.com/supabase/cli/releases/download/v2.115.0/supabase_linux_amd64.tar.gz | tar -xzO supabase > ~/.local/bin/supabase && chmod +x ~/.local/bin/supabase"
```

## Running the stack

From WSL, with the repo accessible at `/mnt/c/Users/myloq/Desktop/KAREN`:

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /mnt/c/Users/myloq/Desktop/KAREN
supabase start   # first run pulls ~2GB of images; subsequent runs are seconds
```

`supabase start` applies every file in `supabase/migrations/` in order, then
`supabase/seed.sql`, and prints the local URLs/keys. Copy the printed
`anon key` and `service_role key` into `.env` (copied from `.env.example`).

## Verifying the schema

```bash
supabase test db          # runs supabase/tests/database/*.sql via pgTAP
supabase db diff          # should be empty against a clean migration history
npm run db:types          # regenerates src/types/database.ts from the live schema
```

## Stopping / resetting

```bash
supabase stop              # stop containers, keep data
supabase db reset          # drop and re-apply every migration + seed, for a clean slate
```

## Studio / inspection

Local Supabase Studio: `http://127.0.0.1:54323`. Local Postgres:
`postgresql://postgres:postgres@127.0.0.1:54322/postgres`. Local Mailpit
(auth emails, if ever enabled): `http://127.0.0.1:54324`.

## Seed accounts (local/dev only — never usable against a real project)

All seeded users share the password `Cims!Local123`.

| Email | Role | Scope |
|---|---|---|
| admin@cims.test | ADMIN | Global |
| hod.cs@cims.test | HOD | Computer Science |
| faculty.ds@cims.test | FACULTY | Data Science (CS501), Section III-A |
| mentor.cs@cims.test | MENTOR | Rahul Nair, Priya Krishnan |
| incharge.cs3a@cims.test | CLASS_INCHARGE | Section III-A |
| student.rahul@cims.test | STUDENT | Self |
| student.priya@cims.test | STUDENT | Self |

Coordinates and any "real-world" identifiers appearing anywhere in
`supabase/seed.sql` are synthetic placeholders — see docs/00 §15, blocker #3.
No production college boundary or classroom coordinate is hard-coded
anywhere in this repository.
