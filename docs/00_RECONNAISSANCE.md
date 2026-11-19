# 00 — Repository Reconnaissance (Phase 1 output)

Produced before any implementation, per `CLAUDE.md` and master prompt §63/§45.
Sources inspected: all 20 steering documents in `docs/`, and every file of
`reference/IRIS-PAYROLL-main` (61 files; TS/JS duplicates counted once).

---

## 1. IRIS architecture summary

| Aspect | Finding |
|---|---|
| Type | Vite + React 19 single-page prototype. No router, no backend, no persistence. |
| Entry | `index.html` → `index.tsx` → `App.tsx` |
| Build | Vite 6, TS 5.8, `@vitejs/plugin-react`, alias `@` → repo root |
| Deps | `react`, `react-dom`, `lucide-react` (icons), `recharts` (charts), `@google/genai` |
| Styling | Tailwind via CDN `<script src="https://cdn.tailwindcss.com">` with an inline `tailwind.config` plus a `<style>` block of CSS custom properties. No PostCSS, no `tailwind.config.js`, no CSS modules. |
| Module loading | Browser `<script type="importmap">` pointing at esm.sh, in addition to npm deps |
| State | `useState` only. No Redux/Zustand/Context except `ToastProvider`. View routing is `useState<ViewState>` plus a `switch` in `App.tsx`. |
| Data | `services/dataService.ts` — 100% in-memory, procedurally generated mock data (`generateEmployee(index)`); `authenticateUser()` compares plaintext passwords in an array. |
| AI | `services/geminiService.ts` — `@google/genai` called directly from the browser, key injected by `vite.config.ts` `define: process.env.API_KEY`. |
| Backend | `server.py` — a Flask demo with in-memory data and `eval()`-based salary formulas. Not wired to the frontend. Dead code for KAREN purposes. |
| Duplicates | Every `.tsx` has a stale `.jsx`/`.js` twin. `.tsx` is the real source; the twins are build residue. |

## 2. Existing reusable components (the UI source of truth)

| File | Reusable pattern extracted |
|---|---|
| `Layout.tsx` | App shell: fixed 256px sidebar, `h-16` sticky blurred header, role-driven nav arrays, notification dropdown, theme toggle, mobile drawer |
| `Login.tsx` | Auth card: blurred radial background orbs, `max-w-md` glass panel, icon-prefixed inputs, gradient logo tile |
| `Dashboard.tsx` | 4-up stat card grid, recharts `AreaChart` panel, Quick Actions list, create-entity modal |
| `EmployeeList.tsx` | The canonical list page: header + actions, list/calendar view toggle, search toolbar, sticky-header table, status pills, per-row Tooltip icon actions, empty state, prev/next pagination |
| `EmployeeDetailModal.tsx` | Detail modal: gradient banner, overlapping avatar, tab strip, inline edit mode |
| `AttendanceCalendar.tsx` | 12-month year grid, per-day status dot, rich hover Tooltip — direct basis for KAREN Student Calendar |
| `WorkforceCalendar.tsx` / `TeamCalendar.tsx` | Month grid + per-person day scheduling |
| `AIChat.tsx` | Floating 384×500 chat panel, bubble styles, thinking state — direct basis for KAREN UI |
| `Toast.tsx` | `ToastProvider` + `useToast()` context, bottom-right stack |
| `Tooltip.tsx` | CSS-only group-hover tooltip |
| `UserManagement.tsx`, `LeaveApprovals.tsx`, `PayrollConfig.tsx`, `ComplianceCenter.tsx` | Further table / form / approval / settings variants |

## 3. Routing and navigation

There is no router. Navigation is:

`App.tsx: const [currentView, setCurrentView] = useState<ViewState>('dashboard')`
→ passed to `Layout` as `currentView` / `onNavigate` → `switch (currentView)` renders a component.

`ViewState` is a string-literal union in `types.ts`. Role determines which nav array
(`superAdminItems` / `adminItems` / `hrItems` / `employeeItems`) is rendered.

## 4. Styling and token structure

Defined in `index.html`, reproduced verbatim for KAREN:

```
accent.primary   #2F5BFF   accent.secondary #4C7DFF   accent.analytics #2ED3B7
status.success   #2ED3B7   status.warning   #F5C451
status.error     #FF5C5C   status.info      #4C7DFF
font: Inter 300/400/500/600/700
```

CSS variables, light `:root` and `.dark`:
`--color-main`, `--color-panel`, `--color-text-primary|secondary|muted`, `--color-border`, `--color-border-hover`.
Dark is the default (`<html class="dark">`). Radii: `rounded-lg/xl/2xl`. Custom 8px scrollbar.
Chart palette duplicated as `CHART_COLORS` in `constants.ts`.

## 5. Authentication

`authenticateUser(username, password)` in `dataService.ts` — plaintext comparison
against a hard-coded array; roles `super_admin | admin | hr | employee`;
credentials printed on the login screen. No session, no token, no server check.
Entirely replaced by Supabase Auth. Only the `Login.tsx` visual survives.

## 6. State and data patterns

Component-local `useState`, `useEffect` on `[page, searchQuery]`, synchronous
service calls, `setTimeout` to fake latency. No caching, no error boundaries,
no loading skeletons beyond a text string. KAREN adds a typed Supabase data layer
behind hooks that keep these call sites shaped the same.

## 7. Existing AI implementation

`geminiService.ts` exposes `sendChatMessage`, `searchRegulations`,
`analyzePayrollAnomalies`, `generatePayrollForecast`, `quickCheck`.
Models `gemini-3-pro-preview` / `gemini-3-flash-preview`. No tools, no auth, no
audit, key shipped to the browser. `AIChat.tsx` holds messages in local state only.
KAREN keeps `AIChat.tsx`'s visual treatment and replaces the entire service.

## 8. Existing calendar implementation

Two. `AttendanceCalendar.tsx` (year-at-a-glance, 12 month cards, status dots +
Tooltip) and `WorkforceCalendar.tsx` (single-month scheduling grid).
Statuses `Present | Leave | Half Day | LOP | Holiday | Weekend | WFH | Absent`.
Data from `getAttendanceForYear(employeeIndex, year)` — deterministic pseudo-random.

## 9. Tables, forms, modals

- Table: `bg-panel border border-border-default rounded-xl overflow-hidden`, toolbar row, `min-w-[800px]`, `thead` `bg-main/50` sticky uppercase, `divide-y divide-border-default`, `hover:bg-main/50`, `p-4` cells.
- Form field: `text-xs text-text-muted uppercase font-bold` label + `bg-main border border-border-default rounded-lg p-3 focus:border-accent-primary`.
- Modal: `fixed inset-0 z-50 bg-black/70 backdrop-blur-sm` + `bg-panel border rounded-2xl animate-in zoom-in-95`, header row with `X`, footer Cancel/Confirm pair.

## 10. KAREN to IRIS component mapping

| KAREN screen | Reused IRIS source |
|---|---|
| Login | `Login.tsx` (branding + Supabase auth) |
| Dashboards (Admin/HOD/Faculty/Student) | `Dashboard.tsx` stat grid + charts + quick actions |
| Students / Faculty / Subjects / Classrooms | `EmployeeList.tsx` |
| Student detail + Student Calendar sub-tab | `EmployeeDetailModal.tsx` + `AttendanceCalendar.tsx` |
| Timetable | `WorkforceCalendar.tsx` grid |
| Live class attendance | `Dashboard.tsx` stat cards + `EmployeeList.tsx` table |
| Attendance override | `EmployeeDetailModal.tsx` edit mode + modal pattern |
| Geofencing | `PayrollConfig.tsx` settings shell wrapping a map (new) |
| Notifications | `Layout.tsx` dropdown + `Toast.tsx` + `LeaveApprovals.tsx` list |
| Reports | `EmployeeList.tsx` table + selection-driven download controls |
| Documents / templates | `ComplianceCenter.tsx` + `EmployeeList.tsx` |
| KAREN | `AIChat.tsx` |
| Settings / Audit | `PayrollConfig.tsx` / `EmployeeList.tsx` |

The only genuinely new visual primitive is the map canvas (campus and block polygon drawing).

## 11. Missing functionality (all of this must be built)

Router; Supabase client/session; RBAC + RLS; every academic entity; timetable and
conflict detection; classrooms with coordinates; three geofence layers; PostGIS
evaluation; presence state machine; class-session lifecycle; attendance engine;
manual override with audit; early-exit detection with GPS verification; authorized
exits; notification engine with retry and dedupe; reports; template document engine
(DOCX/PDF); KAREN orchestration, tool layer, RAG, confirmations, observability;
audit logging; configuration; the entire test suite.

## 12. Required database and API work

No schema or API contract was actually supplied — `03_DATABASE_SCHEMA.md` is a
25-name table list and `11_API_CONTRACT.md` is a 16-item endpoint-group list.
Those names are treated as binding. The column-level schema, constraints,
indexes, RLS policies and request/response schemas are designed here and recorded
in `docs/20_DB_SCHEMA_DETAIL.md` and `docs/21_API_DETAIL.md` so the contract
becomes reviewable. Migrations live in `supabase/migrations/`.

## 13. Required new dependencies (each justified against §56/§41)

| Package | Why nothing existing suffices |
|---|---|
| `@supabase/supabase-js` | Mandated backend platform |
| `react-router-dom` | IRIS has no routing; KAREN needs deep-linkable role-scoped routes |
| `leaflet`, `react-leaflet`, `leaflet-draw` | Polygon drawing on a map. No IRIS equivalent; recharts cannot render maps. Chosen over Google/Mapbox because it needs no API key or billing. |
| `zod` | Structured-output validation for KAREN tool arguments (§43) and API input validation |
| `docxtemplater`, `pizzip` | `{{variable}}` DOCX templating (§29/§24) |
| PDF renderer (Edge-side) | PDF output for the report engine |
| `tailwindcss`, `postcss`, `autoprefixer` | The CDN script is dev-only and cannot ship to production; config values are copied verbatim so output is identical |
| `vitest`, `@testing-library/react`, `playwright` | §51 test suite; none present |

Rejected: shadcn/ui, MUI, any second design system, any second charting library.

## 14. Implementation phases

Follows master prompt §60 (21 phases). Phase 1 is complete with this document.

## 15. Risks and blockers

### Blockers requiring input

1. **Supabase project** — URL, anon key, service-role key. Without them migrations cannot be applied or RLS verified. Code targets the local `supabase` CLI stack until supplied.
2. **AI provider credentials** for KAREN. Gemini keeps parity with IRIS; the provider abstraction in §42 makes it swappable.
3. **Campus coordinates** — a real campus polygon and at least one real classroom lat/long, otherwise geofencing can only be exercised by tests.

### Defects found in the source of truth

1. `index.html` links `/index.css`, which does not exist in the repository. IRIS ships with an unresolved stylesheet.
2. Every component uses `border-border-default`, but the Tailwind config declares `border: { DEFAULT, hover }`, which generates `border-border` and `border-border-hover`. `border-border-default` matches nothing and renders no border. Resolution: add an explicit `default` key to the border color scale so the existing class strings resolve as intended. This preserves every IRIS class name character-for-character instead of rewriting roughly 300 usages.
3. Tailwind CDN plus esm.sh importmap are not production-viable; replaced by a real Tailwind build carrying identical token values.
4. `geminiService` ships the API key to the browser — prohibited by `13_SECURITY_AND_PRIVACY.md`. KAREN runs in Edge Functions.
5. `server.py` uses `eval()` on formula strings. Dead code; excluded from KAREN.
6. Scope: the 21 phases of §60 are a multi-week build. Delivery is sequential, and each phase lands complete (schema + API + RLS + UI + tests) rather than every module landing half-built.
