# 22 — Architecture Decision Records

Decisions not fully dictated by the steering documents, made during
implementation and recorded here per the build instructions ("document
architectural decisions rather than silently making them").

---

## ADR-001 — Tailwind token fix and animation plugin, not a class rewrite

**Status:** Accepted (Phase 2)

**Context:** IRIS components write `border-border-default` (~300 occurrences)
against a Tailwind config that only produces `border-border` /
`border-border-hover`. IRIS also relies on `animate-in`, `fade-in`,
`zoom-in-95`, `slide-in-from-*` utilities that plain Tailwind does not ship.
`index.html` links a nonexistent `/index.css`.

**Decision:**
1. Add `colors.border.default` to `tailwind.config.ts` alongside the existing
   `DEFAULT`/`hover` keys, so `border-border-default` resolves without
   touching any component file.
2. Add the `tailwindcss-animate` plugin, which defines exactly the
   `animate-in`/`fade-in`/`zoom-in`/`slide-in-from-*` utility family IRIS uses.
3. `src/index.css` becomes the real file `/index.css` was supposed to be,
   carrying the token `<style>` block from `index.html` verbatim.

**Rejected alternative:** Search-and-replace `border-border-default` →
`border-border` across every component. Rejected because master prompt §39
requires reusing IRIS source, not editing it, and a mechanical rename across
~300 sites is exactly the kind of unnecessary diff §57/commit-discipline
warns against when a one-line config change fixes it at the root.

**Consequence:** Every ported IRIS component keeps its original className
strings unmodified.

---

## ADR-002 — Routing: `react-router-dom`, not a rewrite of the view model

**Status:** Accepted (Phase 2)

**Context:** IRIS has no router; navigation is `useState<ViewState>` +
`switch` in `App.tsx`. A production app needs deep-linkable, guarded,
role-scoped routes (bookmarkable student detail pages, browser back/forward,
direct links from notifications and KAREN-generated reports).

**Decision:** Adopt `react-router-dom` (data router, `createBrowserRouter`).
Routes are grouped under role-prefixed layouts (`/admin/*`, `/hod/*`,
`/faculty/*`, `/mentor/*`, `/class-incharge/*`, `/student/*`) each wrapped by
the ported `Layout` shell. `Layout`'s `currentView`/`onNavigate` props are
kept as the shell's public interface, but are now derived from
`useLocation()`/`useNavigate()` instead of local state — so `Layout.tsx`
itself required only a thin adapter (`RouterLayout.tsx`), not a rewrite.

**Rejected alternative:** TanStack Router — no IRIS precedent, adds a second
routing paradigm to learn for a repo that already fixes React 19 + Vite +
react-router as the de facto standard for that stack. `react-router-dom` is
the smallest addition that satisfies the requirement.

**Consequence:** `ViewState` (the string-literal union in `types.ts`) is
retired in favour of route paths, but every nav item's `id` is still a stable
string, now interpreted as a path segment rather than a switch case.

---

## ADR-003 — RBAC scope model: assignment table + resolver functions, not a role column

**Status:** Accepted (Phase 4)

**Context:** docs/04 requires department/section/assigned/self scope per role,
and one person is routinely FACULTY + MENTOR + CLASS_INCHARGE simultaneously
(master prompt case list). A single `role` column on `users` cannot represent
multiple concurrent scoped roles.

**Decision:** `user_roles` is a many-row table (`user_id`, `role_id`, optional
`department_id`/`section_id`, validity window). A family of `STABLE SECURITY
DEFINER` SQL functions in the `cims` schema (`my_department_ids()`,
`my_section_ids()`, `my_student_ids()`, `has_permission()`, …) is the single
place scope is resolved; every RLS policy calls these functions rather than
re-deriving reach inline. KAREN's tool layer (Phase 15) calls the identical
functions, so the assistant's reach is provably no wider than the REST API's.

**Rejected alternative:** Postgres native roles (`GRANT ... TO`). Rejected
because native roles cannot easily carry per-row scope (a department id) or
a validity window, and Supabase's RLS model is designed around table-based
policies evaluated per statement, not per Postgres role.

**Consequence:** Every new table added in later phases must be reviewed
against these resolver functions rather than inventing a new scope predicate.

---

## ADR-004 — KAREN's AI key never reaches the browser; provider is swappable

**Status:** Accepted (Phase 3, enforced from Phase 14 onward)

**Context:** IRIS's `geminiService.ts` calls `@google/genai` directly from
the browser with the key inlined by Vite's `define`. docs/13 and master
prompt §10/§42 explicitly prohibit this and require a provider abstraction.

**Decision:** KAREN's HTTP surface is a single Edge Function
(`supabase/functions/karen-chat`). The browser never imports an AI SDK. The
Edge Function loads `KAREN_PROVIDER`/`KAREN_API_KEY` from its own secret
store and dispatches through a `Provider` interface
(`src/karen/providers/types.ts`) with one file per backend. Until a real
provider is configured, `KAREN_PROVIDER=fixture` selects a deterministic
in-repo provider used by tests; the Edge Function returns a typed
`PROVIDER_NOT_CONFIGURED` error rather than fabricating a response if asked
to run in production without a key.

**Consequence:** Switching provider is a config change (`KAREN_PROVIDER`,
`KAREN_MODEL`, `KAREN_API_KEY`), never a code change to KAREN's orchestration
logic.

---

## ADR-005 — `EmployeeList.tsx` generalised into one `EntityListPage`, not five copies

**Status:** Accepted (Phase 5, referenced here as it affects Phase 2 component porting)

**Context:** docs/17 maps Students, Faculty, Subjects, Classrooms and several
report screens all onto "IRIS list/table pages." Copy-pasting
`EmployeeList.tsx` five times would satisfy the letter of "reuse the exact
component" while creating five divergent copies of the same bug surface.

**Decision:** Port `EmployeeList.tsx`'s DOM structure and className strings
into one generic `<EntityListPage columns rows toolbar renderRowActions />`
component; each entity screen supplies data and column config. The rendered
output is unchanged from copying the component five times — same table
classes, same toolbar, same pagination controls — because the column/row
contract only parameterises content, not structure or styling.

**Consequence:** A visual fix to the table (e.g. a future density change)
lands once. This is a structural refactor of *reused* markup into a shared
component, not a redesign, so it does not conflict with docs/18 Rule 6 (no
duplicate design system) — it is the same design system, applied through one
component instead of five.

---

## ADR-006 — Two Supabase local-stack defects found and fixed during Phase 4 verification

**Status:** Fixed (Phase 4)

**Context:** Master prompt §51 requires every phase to include tests, run
against something real, not postponed. Running `supabase start` against the
migrations in this repo surfaced two real defects that a purely textual
review would not have caught:

1. `public.users.email` and `public.students.contact_email` were typed
   `citext` in migrations `20260101000300`/`20260101000400`, but the
   `citext` extension was never enabled in `20260101000100_extensions_and_conventions.sql`.
   `supabase db reset` failed outright with `type "citext" does not exist`.
2. Local sign-in returned `422 email_provider_disabled` even with a correctly
   seeded `auth.users`/`auth.identities` row and `email_confirmed_at` set.
   The first fix attempted — adding `enabled = true` under `[auth.email]` —
   was wrong and left the bug in place, because no such key exists in this
   CLI's config schema at all (confirmed by extracting the config schema's
   key list directly from the CLI binary via `strings`). Doing the same
   extraction against the code path that builds the GoTrue container's
   environment found the actual cause:
   `GOTRUE_EXTERNAL_EMAIL_ENABLED: String(H.email.enable_signup)`. In CLI
   v2.115.0, `[auth.email] enable_signup` is not "may a user self-register" —
   it is the master switch for the entire email provider, gating sign-**in**
   equally with sign-up. Self-service registration is actually blocked by
   the separate top-level `[auth] enable_signup` (`-> GOTRUE_DISABLE_SIGNUP`),
   which was already set correctly. Setting `[auth.email] enable_signup =
   false` — the reading its name suggests, and what was originally written —
   locks out every provisioned account, not just self-registration.

**Decision:** Fix both at the root. Added
`create extension if not exists citext with schema extensions;` to the
extensions migration and schema-qualified both column definitions as
`extensions.citext` rather than relying on search_path. Set
`[auth.email] enable_signup = true` (email provider stays on) while leaving
the top-level `[auth] enable_signup = false` (self-registration stays
blocked) — the two flags are independent despite the shared name, and the
config file now carries a comment explaining why, so the next person does
not repeat the same wrong first fix.

**Consequence:** This is why master prompt §51 insists tests run per phase
rather than at the end — none of these three things (the wrong key name, the
wrong flag, the underlying citext gap) were visible to `tsc`, to a code
review, or to the pgTAP suite itself, which never got to run until the stack
started and a real login actually succeeded. Verified via `supabase db
reset` completing clean and a real `POST /auth/v1/token?grant_type=password`
returning a session for a seeded account.

---

## ADR-007 — Own-record access is keyed to identity, not to a live role assignment

**Status:** Accepted (Phase 4)

**Context:** `students_select_scoped`'s USING clause and
`cims.my_student_ids()` both carry an unconditional `user_id = auth.uid()` /
`st.user_id = auth.uid()` branch — a principal can always read the student
row that is their own identity, regardless of whether their STUDENT
`user_roles` assignment is currently active or inside its validity window.
The first version of the pgTAP suite (`supabase/tests/database/001_rbac_scope.test.sql`)
asserted the opposite — that expiring the role assignment should zero out
*all* access, including to the student's own row — and that assertion failed
against real RLS, correctly, because it encoded the wrong invariant rather
than finding a bug.

**Decision:** Keep the unconditional own-record clause. Two independent
mechanisms exist for two independent purposes, and conflating them would be
the actual bug:
- `public.users.status` / `public.students.status` is the standing kill
  switch — checked by `cims.is_active_user()` at the top of every policy,
  and by design it locks out *everything*, including the own-record read.
- A `user_roles` assignment's `valid_until` governs *derived* capability —
  what `has_permission()` grants, what `my_student_ids()`/`my_section_ids()`
  resolve for reaching *other* people's rows — and is expected to move
  independently of whether the underlying person can still see themself.

docs/04 states "Students see their own data" without conditioning that on an
active role grant being currently in its validity window, which matches this
reading: a lapsed or administratively-lagging role assignment should not be
able to 404 a student out of their own profile.

**Consequence:** The pgTAP suite was corrected instead of the schema — it now
asserts that an expired assignment removes derived capability
(`has_permission('attendance.read')` becomes false) while the own-row read
persists, and documents why in an inline comment so a future reader does not
"fix" this back the other way. Any new table added in a later phase that
needs an own-record bypass should follow the same pattern deliberately, not
copy it by habit — most tables (e.g. `student_subject_enrolments`) reach the
student only through `cims.my_student_ids()`, inheriting this same rule
automatically.

---

## ADR-008 — Base table GRANTs are separate from RLS and were missing entirely

**Status:** Fixed (Phase 4)

**Context:** The original `20260101000700_rls_policies.sql` defined RLS
policies for every table but never issued a `GRANT` to the `authenticated`
role. Running the pgTAP suite against the real local stack surfaced this
immediately: every query as a simulated authenticated principal failed with
a bare `permission denied for table students`, before RLS was ever
evaluated. `GRANT` and `RLS` are two independent gates in Postgres — GRANT
decides whether a role may touch a table's rows at all; RLS policies then
decide *which* rows — and this local image's baseline privileges do not
extend `SELECT`/`INSERT`/`UPDATE`/`DELETE` to `authenticated` automatically
the way Supabase's hosted dashboard template does. Every `create policy`
statement in the migration was, until this was found, dead code.

**Decision:** Added an explicit grant block at the top of
`20260101000700_rls_policies.sql`: `authenticated` gets full CRUD on every
table (RLS still restricts rows), `audit_logs` is `SELECT`-only for
`authenticated` (writes only via `cims.write_audit`), `service_role` gets
`ALL` (Supabase convention — it bypasses RLS and is used only by Edge
Functions/CI), and `ALTER DEFAULT PRIVILEGES` extends the same pattern to
every table a later migration adds, so this does not need repeating per
phase.

**Consequence:** This is the same lesson as ADR-006 stated more sharply:
"the migration looks correct" and "the migration works" are different
claims, and only the second one was tested here — by running the actual
pgTAP suite against a real database rather than reviewing the SQL text. Every
later phase's migration must include the equivalent grant for any new table,
or it inherits from `ALTER DEFAULT PRIVILEGES` automatically — either way,
this needs verifying by test, not by reading the policy list.

---

## ADR-009 — College-issued login, forced first-password-change, and the RLS gap it surfaced

**Status:** Accepted (Phase 5)

**Context:** The institutional login requirement ("User ID" = college email,
admin-provisioned accounts requiring a forced password change on first
sign-in, self-service "forgot password") was layered onto the already-shipped
Login flow. Building the forced-change gate required tracing exactly what a
signed-in, non-privileged user CAN write on their own `public.users` row —
and `users_update_self` (20260101000700) turned out to be row-scoped only
(`id = auth.uid()`). RLS in Postgres is row-level, not column-level: nothing
stopped a signed-in user from writing `status`, `email`, or any other column
on their own row, including reactivating themselves out of an
administrator-imposed `SUSPENDED` status.

**Decision:**
1. `public.users.must_change_password` (migration `20260101000800`) drives a
   `ChangePasswordGate` rendered by `RequireAuth` — the single choke point
   every routed screen already passes through — so no route is reachable by
   URL while a change is pending.
2. `cims.restrict_self_user_update()` (BEFORE UPDATE trigger) confines a
   non-privileged self-edit to `full_name`/`phone`; every other column snaps
   back to its stored value. Column-level `GRANT` could not express this
   distinction: self-edits and admin edits both execute as the same Postgres
   role (`authenticated`), so only a trigger — which sees the specific row
   and the acting user — can tell them apart.
3. `must_change_password` clears only through `public.complete_password_change()`,
   never a plain client `UPDATE`, so "the flag cleared" and "Supabase Auth
   actually accepted a new password" cannot drift apart. That RPC and the
   trigger run as the same non-privileged caller (`SECURITY DEFINER` changes
   table privileges, not `auth.uid()`), so the trigger cannot tell the RPC's
   own UPDATE apart from an arbitrary one without an explicit signal — it
   sets the transaction-local GUC `cims.allow_password_change_clear` immediately
   before its UPDATE as that signal.
4. `PASSWORD_RECOVERY` (Supabase's "forgot password" email-link event) is
   tracked as separate provider state (`isPasswordRecovery` in
   `AuthProvider`), not folded into `must_change_password`: the link lands on
   `/login`, outside `RequireAuth`'s tree entirely, and `detectSessionInUrl`
   would otherwise sign the user straight into the app without ever
   prompting for a new password.

**Consequence:** Every fix here came from actually running the migration
against seed data, not from reviewing the SQL — the trigger's first version
also rejected `seed.sql`'s own `UPDATE` (run by `postgres` directly, no
session, so `auth.uid()` is null) with "Not authorised to modify this user",
which is now an explicit early-return rather than a coincidence of who
happens to run it. `docs/20_DB_SCHEMA_DETAIL.md`'s `public.users` entry and
`supabase/tests/database/002_auth_hardening.test.sql` (8 assertions) cover
the resulting behaviour; both should be read before touching this table's
policies or triggers again.

---

## ADR-010 — Student Calendar's "three required buttons": flagged assumption

**Status:** Provisional (Phase 6) — needs confirmation

**Context:** Every steering document that mentions Student Calendar
(`01_PRD.md`, `12_UI_UX_SPEC.md`, and the Phase 6/9 prompts themselves)
requires "the three required top-level category buttons" atop the screen,
repeated verbatim across multiple messages, but never once defines what the
three categories are. Checked again at Phase 6: absent from all 15 docs, both
CLAUDE.md variants, and every prompt so far.

**Decision:** Implemented as a **Month / Semester / Year** range selector
(`src/features/students/StudentCalendarPage.tsx`) rather than blocking Phase
6 on it or inventing attendance-status categories (Present/Absent/Leave)
that would need fabricated data to demonstrate before Phase 9's attendance
engine exists. This satisfies "three buttons atop the calendar" and needs no
data the app doesn't have yet.

**Consequence:** This is explicitly a placeholder-for-a-decision, not a
guess dressed up as done — flagged in the component's own header comment so
it surfaces again the next time someone reads that file, and here so it
surfaces in a project-wide search for open decisions. Swapping it for the
real three categories, whatever they turn out to be, is a self-contained
change to that one component; nothing else depends on which three buttons
these are.

---

## ADR-011 — Timetable conflicts enforced by EXCLUDE constraints, not a pre-check

**Status:** Accepted (Phase 7)

**Context:** The master prompt is explicit that "two users creating the same
conflicting timetable entry concurrently must still be prevented" — a
`SELECT ... WHERE overlaps` before an `INSERT` cannot actually guarantee
that: two concurrent transactions can both pass the check before either
commits (the classic check-then-act race).

**Decision:** Three `EXCLUDE USING gist (col WITH =, ..., time_range WITH &&)`
constraints on `timetable_entries` (faculty, section, classroom — each
scoped to `semester_id` and `day`, `where status = 'ACTIVE'`), backed by
`btree_gist` (already enabled since Phase 3). Postgres enforces these as
part of the same index the INSERT itself uses, so a conflicting concurrent
write is serialised by the database, not merely made statistically unlikely
by an application-level check. `time_range` is a generated `int4range` over
minutes-since-midnight, since Postgres has no built-in time-range type
usable with `&&`.

**Consequence — a real bug this surfaced, not just designed around:** the
first version of the generated column was a bare `int4range(start, end,
'[)')`. For an invalid row (`end_time <= start_time`), that expression
itself raises Postgres's own `22000` ("range lower bound must be less than
or equal to range upper bound") during tuple construction — *before* the
named `timetable_valid_time` CHECK constraint (`end_time > start_time`,
`23514`) ever gets evaluated. Running the pgTAP suite caught this
immediately (a test expecting the clean `23514` got `22000` instead); the
expression is now `case when end_time > start_time then int4range(...) else
null end`, so invalid rows produce a NULL range (which never matches any
EXCLUDE overlap) and fail on the intended, named constraint instead.

Two further test-authoring bugs surfaced by the same run, corrected in the
test file rather than the schema: the conflict tests initially tried to
insert `faculty_subject_assignments` fixtures as the HOD principal the file
was simulating, but HOD does not hold `faculty.write` under the Phase 4
permission model (only `faculty.read`) — fixture setup needing a capability
the principal under test doesn't have has to run as a role that legitimately
holds it (mirrors ADR-006's "reset role" pattern for `auth.users` fixtures).

---

## ADR-012 — Leaflet without react-leaflet for the classroom coordinate picker

**Status:** Accepted (Phase 7)

**Context:** The classroom location UI needs one interactive map: a
draggable marker plus a radius circle, with manual lat/long entry as a
fallback — a point+radius geofence, explicitly not the polygon-drawing tool
Phase 8's campus/department geofences will need. `react-leaflet`'s
documented-stable major (v4) declares React 18 as its peer dependency; this
project is on React 19 throughout, and `npm install` failed outright with an
unresolvable peer conflict.

**Decision:** Install plain `leaflet` (no React binding) and drive it
imperatively inside a single `useEffect`-managed component
(`src/features/classrooms/ClassroomMapPicker.tsx`) — map init once, marker
drag/map click both call the same `onChange(lat, lng)`, a second effect
keeps the marker/circle in sync when coordinates change from outside (manual
entry, or the parent form resetting on edit-open). One widget with one
marker and one circle does not need a full React reconciliation layer over
Leaflet; the peer-dependency conflict made that trade-off easy rather than
merely acceptable.

**Consequence:** No default tile server is wired in — `tileUrl`/`attribution`
are optional props the caller supplies, since every real deployment should
point this at its own tile provider under that provider's terms rather than
inherit a default baked into this repo. Without one, the map still renders
(marker, circle and manual lat/long entry all still work) with a blank grey
canvas instead of basemap imagery. Phase 8's polygon-drawing tool for
campus/department geofences will very likely want `leaflet-draw` layered on
this same plain-Leaflet foundation, not a second mapping library.

---

## ADR-013 — leaflet-draw confirms ADR-012's prediction; ST_Covers over ST_Contains for boundary membership

**Status:** Accepted (Phase 8)

**Context:** Phase 8 needed a polygon drawing/editing tool for campus and
department/block geofences. ADR-012 predicted `leaflet-draw` would layer
cleanly onto the plain-Leaflet foundation `ClassroomMapPicker` established,
since it has no React binding to conflict with — it patches the global `L`
the same way any Leaflet plugin does. That held: `leaflet-draw` installed
with no peer-dependency conflict (unlike `react-leaflet`), and
`GeofenceMapEditor` follows the identical imperative-`useEffect` pattern.

Separately: `public.point_in_campus`/`point_in_department` needed to decide
whether a GPS sample sitting exactly on a boundary counts as "inside" — a
real question, not an edge case to hand-wave, since a classroom or campus
edge is exactly where boundary noise is most likely to land a real sample.

**Decision:** Both functions use `ST_Covers(boundary, point)`, not
`ST_Contains`. `ST_Contains` requires the point to be in the polygon's
*interior*, excluding the boundary itself; `ST_Covers` includes it. A sample
landing precisely on the fence line should read as on-campus/in-department,
not fall through a gap in the semantics — confirmed in pgTAP by asserting a
point on the exact boundary of the test polygon resolves true.

**Consequence:** Phase 9/10's attendance and early-exit engines inherit this
choice automatically by calling these same functions rather than writing
their own `ST_Covers`/`ST_Contains` — the boundary-inclusive behaviour only
needs to be correct once, here, not re-decided at every call site.
`geofences_boundary_valid` (`ST_IsValid`) rejects a self-intersecting
polygon a drawing UI could otherwise produce, verified in pgTAP with an
actual bowtie polygon rather than assumed from the constraint's presence.

---

## ADR-014 — no live scheduler exists in this environment for the attendance engine

**Status:** Accepted (Phase 9), documenting a genuine blocker

**Context:** The attendance engine's design (docs/06, master prompt §61)
calls for periodic evaluation: as a class session's window is open, a
scheduler should repeatedly call the evaluation function as new location
samples arrive, and close the session once its window elapses. This
environment has no cron/worker process that can run on a schedule — every
piece of SQL here executes only when explicitly invoked.

**Decision:** Build the complete, real evaluation logic
(`cims.evaluate_class_session`, `public.evaluate_class_session`,
`public.finalize_class_session`) as callable functions, and expose two real
callers: the live faculty dashboard's "Refresh" button
(`AttendancePage.tsx`, calls `public.evaluate_class_session` on demand) and
the "Finalize" button (`public.finalize_class_session`). Both are the same
functions a production Edge Function/cron would call automatically — this
is not a stand-in implementation that will need replacing, only the
*trigger* is manual here instead of scheduled.

**Consequence:** This is a genuine, documented limitation, not something
papered over. A production deployment needs a Supabase Edge Function
scheduled (e.g. via `pg_cron` or an external scheduler) to call
`public.evaluate_class_session` for every OPEN/ATTENDANCE_OPEN session on a
short interval, and `public.finalize_class_session` once each session's
window has genuinely elapsed. Until that scheduler exists, attendance for a
session only updates when a human opens the live dashboard and clicks
Refresh/Finalize.

---

## ADR-015 — attendance_records RLS cannot reuse cims.my_section_ids()

**Status:** Accepted (Phase 9)

**Context:** Every other per-section table introduced since Phase 7
(`timetable_entries`, `class_sessions`) correctly reuses
`cims.my_section_ids()` for its read policy — that function already encodes
exactly the right reach per role (ADMIN all, HOD department, CLASS_INCHARGE
own section, FACULTY assigned sections, MENTOR mentee sections, STUDENT own
section). `attendance_records` looked like it should follow the same
pattern. It cannot: `cims.my_section_ids()` deliberately includes a
STUDENT's own section (correct — a student needs to see their own section's
timetable), and STUDENT also holds `attendance.read` (for reading their own
attendance). Combining `attendance.read` with `section_id in
my_section_ids()` would let a student read *every classmate's* individual
attendance row in their own section, not just their own.

**Decision:** `attendance_records_select` enumerates staff reach explicitly
(admin / the session's own faculty / a SECTION-scoped role assignment on the
session's section / a department-scoped HOD / the specific student's
assigned mentor) instead of delegating to `my_section_ids()`, with a
separate, always-available `student_id = cims.my_student_id()` branch for
the student's own row. `override_attendance()` re-derives the identical
staff-reach check inline (it runs `SECURITY DEFINER`, so there is no table
RLS policy for it to lean on) rather than importing a shared function, to
keep the exact authorization logic visible at the point it matters most —
a manual attendance override.

**Consequence:** Any future table with a similarly sensitive per-student row
(marks, for instance, when that arrives) should be checked against this same
question before reusing `my_section_ids()`: does the "own record" path for
STUDENT, combined with the read permission STUDENT holds, accidentally grant
visibility into every other row in the same set? If yes, enumerate staff
reach explicitly, the way this table does.

---

## ADR-016 — six real timing bugs in the attendance engine, all found by pgTAP

**Status:** Recorded (Phase 9), for anyone touching this engine's timing logic again

**Context:** `supabase/tests/database/007_phase9_attendance.test.sql` took
nine iterations to pass cleanly. Every failure was a genuine bug in the
migration, not a test artifact — recorded here because the underlying
lesson (Postgres transaction-timestamp semantics interacting with a
same-transaction test harness) will bite again the next time someone adds
time-sensitive logic to this schema.

1. **Enum literals inside a `CASE` assigned to a typed column need an
   explicit cast.** `SET status = CASE WHEN ... THEN 'VERIFYING' ... END`
   failed with "column is of type attendance_status but expression is of
   type text" — Postgres does not infer the enum type from the target
   column when every `CASE` branch is a bare string literal (unlike a plain
   `SET status = 'VERIFYING'`, or a PL/pgSQL `variable := CASE ... END`
   assignment, both of which resolve fine). Fixed with `'VERIFYING'::public.attendance_status`
   on every branch.

2. **`now()` is frozen for an entire transaction; `location_samples.recorded_at`
   needed `clock_timestamp()` instead** — see this ADR's own table-level
   note and the schema doc entry above. Without it, several samples
   submitted in the same pgTAP transaction shared one timestamp, and "most
   recent sample" ordering became arbitrary.

3. **The window's real-time upper bound (`least(now(), window_end)`) had
   the same bug** — samples stamped with the now-advancing `clock_timestamp()`
   could exceed a cap still expressed as the frozen `now()`, silently
   excluding legitimate recent samples. Changed to
   `least(clock_timestamp(), window_end)`.

4. **Two test sessions with overlapping windows let a sample meant for one
   bleed into the other's evaluation** — `location_samples` carries no
   `class_session_id` (a real phone submitting GPS has no notion of "which
   session"), so "most recent sample within window" is the only signal the
   engine has. Real `timetable_entries` can never overlap for the same
   section (Phase 7's EXCLUDE constraints), so this can only happen when a
   test hand-crafts two sessions both open "right now" — which the original
   test did, for convenience. Fixed by anchoring the second session's window
   to `clock_timestamp()` captured at its own creation (chronologically
   after every sample the first session's tests had already recorded),
   rather than an arithmetic offset from the shared frozen `now()`.

5. **A `- interval` "safety margin" on that same window's start reached
   backward far enough to catch a sample from milliseconds earlier in the
   same fast-executing transaction.** Subtracting time from a window start
   to "be safe" is backwards when the thing you are trying to exclude is
   itself very recent; the fix was to not offset backward at all.

6. **`finalize_class_session` was declared `SECURITY INVOKER` but performs
   its own `UPDATE` on `attendance_records`, which has no direct-write RLS
   policy at all (by design — see ADR-015).** As invoker, that UPDATE
   matched zero rows under RLS and failed silently; the function returned
   successfully while doing nothing. Caught only because the test asserted
   the actual resulting status (ABSENT) rather than merely that the call
   succeeded. Fixed by declaring it `SECURITY DEFINER`, matching
   `override_attendance()`'s already-correct pattern, with its own
   permission/scope checks re-derived inline exactly as ADR-015 describes.

---

## ADR-017 — early-exit tables safely reuse `cims.my_student_ids()`; the ADR-015 trap does not apply here

**Status:** Accepted (Phase 10)

**Context:** ADR-015 established that `attendance_records` cannot delegate
its read policy to `cims.my_student_ids()`/`cims.my_section_ids()` because
STUDENT's membership in that set, combined with STUDENT holding
`attendance.read`, would leak every classmate's row. Phase 10's
`student_presence_state` and `early_exit_events` are structurally the same
shape — one row per student, STUDENT holds `location.read` for their own
data — so this had to be checked again rather than assumed safe by analogy.

**Decision:** It is safe here, for a reason specific to this schema rather
than a coincidence: `cims.my_student_ids()` for a STUDENT principal resolves
to exactly **one** id (their own `student_id`) — unlike `my_section_ids()`,
which resolves to every student sharing their section. `student_id in
cims.my_student_ids()` combined with `location.read` therefore reduces to
exactly the own-row check for STUDENT, and expands correctly for staff
scopes (mentor, class in-charge via department, HOD, admin). Both tables'
RLS policies use `my_student_ids()` directly, unlike `attendance_records`.

**Consequence:** The general rule from ADR-015 stands: before delegating a
new per-student table's RLS to a resolver function, check what that
function actually returns for the STUDENT role, not just what it returns
for staff roles. `my_student_ids()` happens to be safe for STUDENT callers
in every table introduced so far; `my_section_ids()` is not, and never will
be, for any table STUDENT also holds a table-wide read permission on.

---

## ADR-018 — Early Exit folded into Geofencing as a tab, not a new nav item

**Status:** Accepted (Phase 10)

**Context:** docs/12's fixed navigation list has no "Early Exit" entry — the
same constraint ADR-010 already hit for Student Calendar, and every steering
document enumerating nav items was checked again here and confirmed still
silent on where early-exit monitoring surfaces in the UI.

**Decision:** Fold `EarlyExitPage` into `GeofencingPage` as a second tab
(`'boundaries' | 'early-exit'`), mirroring the existing
`AcademicStructurePage` tab pattern rather than inventing a new top-level nav
slot docs/12 doesn't define. The original `GeofencingPage` component (the
boundary/polygon editor) was renamed to `BoundariesTab` and is no longer
exported directly; a new top-level `GeofencingPage` owns the tab switcher and
renders `BoundariesTab`/`EarlyExitPage` underneath it.

**Rejected alternative:** A standalone route/nav entry for Early Exit.
Rejected for the same reason ADR-010 rejected inventing calendar categories:
docs/12's nav list is treated as fixed inventory, not a menu to add to
without a steering document actually calling for a new item — geofencing and
early-exit monitoring are also the same underlying domain (docs/07 defines
early-exit purely in terms of the campus geofence), so grouping them is not
an arbitrary pairing.

**Consequence:** Two follow-on bugs from the restructure, both caught by
`npx tsc --noEmit` (not runtime testing — the mismatch was a duplicate JSX
heading, not a type error the compiler flagged directly, but reviewing the
diff against the render output surfaced it during the same pass): the inner
`EntityListPage`'s `title` prop still read `"Geofencing"`, duplicating the
new wrapper's own `<h2>Geofencing</h2>` — retitled to `"Boundaries"`; and
`EarlyExitPage` still carried its own now-redundant `<h2>Early Exit
Monitoring</h2>` header block — removed, since the tab label already
communicates which view is active. Any future module that needs to fold
into an existing nav item rather than get its own should follow this same
two-step check: retitle the embedded list's own heading, and strip the
folded-in component's now-duplicate header.

---

## ADR-019 — no external notification delivery channel exists in this environment

**Status:** Accepted (Phase 11), documenting a genuine blocker

**Context:** docs/07's notification lifecycle (`CREATED -> QUEUED ->
SENT/FAILED -> RETRYING -> SENT/EXHAUSTED`) presumes a real transport — an
email/SMS/push provider that can genuinely fail (rate limits, bounces,
provider outages) and needs retrying. No such provider is configured in
this environment, the same class of gap as ADR-014 (no live scheduler for
the attendance engine): the logic can be built completely real, but nothing
external exists yet to plug into it.

**Decision:** Define "delivery" as durably persisting the notification row
plus a Supabase Realtime `postgres_changes` broadcast to the recipient's own
RLS-scoped subscription — which is real, in-app delivery, not a stand-in.
`cims.enqueue_notification` calls `cims.deliver_notification` synchronously
because this delivery mechanism has no failure mode short of the INSERT
itself aborting the transaction (already a hard error, not a `FAILED`
status). The full `RETRYING`/`FAILED`/`EXHAUSTED` state machine is still
built and exercised by pgTAP against simulated failures
(`cims.record_delivery_failure`, called by a test the same way a future
external-channel Edge Function would call it in production), so a real
provider integration is a caller change, not a schema or logic change.

**Consequence:** A production deployment that wants email/SMS/push needs an
Edge Function subscribing to `QUEUED`/`RETRYING` notifications and calling
`cims.deliver_notification` on success or `cims.record_delivery_failure` on
a real transport error — exactly ADR-014's pattern of "the trigger is
manual/absent here, not the logic." Until that exists, every notification
in this deployment is delivered exactly one way: in-app, via the bell
dropdown and NotificationsPage's Realtime subscription.

---

## ADR-020 — the notification self-update guard blocked the engine's own lifecycle writes; fixed with the same GUC escape hatch as ADR-009

**Status:** Fixed (Phase 11)

**Context:** `cims.restrict_notification_self_update()` (a BEFORE UPDATE
trigger, added to close the same column-level gap ADR-009 found on
`public.users` — RLS is row-scoped, so `notifications_mark_read_self`
alone could not stop a recipient rewriting their own notification's title)
reverts every column except `read_at` and a `status` move to `READ`.
Triggers fire on every UPDATE regardless of `SECURITY DEFINER`, so this also
silently reverted `cims.deliver_notification`'s and
`cims.record_delivery_failure`'s own lifecycle UPDATEs — `status` could
never actually reach `SENT`/`RETRYING`/`EXHAUSTED` at all. Found by running
`009_phase11_notifications.test.sql`, not by reading the trigger: every
lifecycle assertion failed with the row stuck at `QUEUED`, attempts at 0,
even though the enqueue/deliver/fail functions had all "succeeded" (no
exception raised — an UPDATE matching a row but having its column changes
silently reverted by a trigger produces no error, the same silent-failure
shape ADR-016's bug 6 had with a missing RLS policy instead of a trigger).

**Decision:** Add a transaction-local GUC,
`cims.allow_notification_lifecycle_update`, set to `'on'` immediately before
and reset to `'off'` immediately after the UPDATE inside both
`cims.deliver_notification` and `cims.record_delivery_failure` — identical
mechanism to `cims.allow_password_change_clear` (ADR-009), which exists for
the same underlying reason: a SECURITY DEFINER function's own UPDATE needs
to signal the trigger that this specific write is the trusted engine path,
not an arbitrary client UPDATE riding on the same table/role. The reset
back to `'off'` matters here specifically because pgTAP wraps an entire test
file in one transaction — without it, the escape hatch would stay open for
every subsequent UPDATE in the same file, including the later assertions
that verify a recipient's own tamper-attempt gets reverted.

**Consequence:** Any future BEFORE UPDATE guard trigger added to a table
that a SECURITY DEFINER engine function also writes to must be checked
against this same question: does the trigger fire for the engine's own
writes, and if so, does the engine's function explicitly get past it? A
missing RLS write policy (ADR-015/ADR-016 bug 6) and a column-restricting
trigger (this ADR, ADR-009) are two different mechanisms with the identical
failure shape — "the function call succeeds but nothing actually changes" —
and both are invisible to a code review that doesn't run the migration
against real test data.

---

## ADR-021 — Reports are security_invoker reads with no report-specific authorization; CSV now, PDF/DOCX/XLSX in Phase 13

**Status:** Accepted (Phase 12)

**Context:** docs/10 states one binding rule for the whole report engine:
"Generated artifacts inherit user authorization scope," and separately lists
PDF/DOCX/CSV/JSON/XLSX as required output formats. Two design questions
follow from that: how a report decides what rows to include, and how much
of the output-format list this phase needs to satisfy versus Phase 13
(Document Generation), which the master phase plan lists separately.

**Decision:**
1. Every report object (five new views/functions in
   `20260101002100_reports_views.sql`) is `security_invoker`/`SECURITY
   INVOKER` and contains no permission or scope check of its own — it is a
   join/aggregate over tables that already have real RLS policies (Phase
   4/9/10's `attendance_records`, `early_exit_events`, `audit_logs`,
   `user_roles`). This is the same reasoning as Phase 6's `department_stats`
   view (ADR, that phase): a report is a *read*, and the tables it reads
   already define who may read what. Writing a second, parallel scope check
   inside each report would risk the two drifting apart — the actual bug
   class ADR-015 exists to prevent.
2. Only CSV ships in this phase (`src/lib/csv.ts`, client-side, from
   already-fetched rows — no server-side rendering step exists to build).
   PDF/DOCX/XLSX are Phase 13's explicit responsibility (Document
   Generation) and will render the identical report data this phase
   produces, not a separately-derived dataset.

**Rejected alternative:** Building a bespoke "report access" permission
layer distinct from the underlying tables' own RLS. Rejected because docs/10's
rule is literally "inherit," not "re-derive," and a hand-written second
scope check is exactly the kind of duplicated authorization logic that has
caused real bugs elsewhere in this project when the two copies disagreed
(ADR-015's motivating example, though not itself a duplication bug).

**Consequence:** Adding a new report category later means adding a
`security_invoker` object over an already-RLS-protected table, not adding a
new authorization rule — reviewed the same way `department_stats` is:
confirm the underlying table's RLS is what actually would be shown, not the
view's own logic (there is none to review). The Notification and Geofence
report categories named in docs/10 needed no new backend object at all: the
former is answered honestly as "your own delivery history" (notifications
RLS is recipient-only by design, so no system-wide version can exist without
changing that design elsewhere), the latter reuses Phase 8's existing
`geofences_geojson` view rather than duplicating it.
