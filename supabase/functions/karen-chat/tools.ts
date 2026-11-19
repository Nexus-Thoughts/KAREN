// KAREN's tool layer (Phase 15). docs/09_AI_TOOLS_AND_AGENTS.md's binding
// rule: "Never expose arbitrary SQL or undocumented tools to the agent" —
// every entry below is one of the fixed 14 tools that document lists, each
// with an input schema (zod), and every implementation queries through
// `ctx.db`, a Supabase client authenticated as the *calling user's own JWT*
// (see index.ts) — never the service role. RLS on every table below is the
// real authorization boundary; a tool cannot see more than the same user
// already could through the ordinary UI (docs/08 "Safety: no RBAC bypass").
//
// Where the underlying capability genuinely does not exist yet (RAG/
// search_knowledge has no document corpus until Phase 16; generate_document
// today only runs client-side via src/lib/documentGeneration.ts, not from
// an Edge Function), the tool returns a typed NOT_IMPLEMENTED result rather
// than a fabricated one (docs/08 "no fabricated values").
import { z } from 'npm:zod@3.24.1';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';

export interface ToolContext {
  db: SupabaseClient;
  userId: string;
  /**
   * Turns text into the same embedding space scripts/reindex-knowledge.mjs
   * indexed docs/ into (Phase 16). Undefined when the active provider has no
   * embedding backend (e.g. KAREN_PROVIDER=fixture) — search_knowledge
   * checks for that explicitly rather than calling a function that doesn't
   * exist, so the failure mode is a typed message, not a 500.
   */
  embed?: (text: string) => Promise<number[]>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema, sent to the provider
  schema: z.ZodTypeAny; // parsed/validated server-side before execution
  isWrite: boolean;
  /**
   * Phase 17 — when true, calling this tool never runs `run` directly.
   * karen-chat/index.ts instead records a karen_pending_actions row and
   * returns a CONFIRMATION_REQUIRED result; `run` only actually executes
   * once the user confirms (index.ts's confirmActionId branch). Every
   * isWrite tool must set this — KAREN never mutates data on its own
   * say-so mid-conversation (docs/08).
   */
  requiresConfirmation?: boolean;
  /** Human-readable summary of what this call would do, shown before confirming. Required when requiresConfirmation is true. */
  describe?: (args: unknown) => string;
  run: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

const NOT_IMPLEMENTED = (tool: string, phase: string) => ({
  error: 'NOT_IMPLEMENTED',
  message: `${tool} is not implemented yet — it depends on work planned for ${phase}. KAREN will not guess at this.`,
});

const empty = z.object({});
const withStudentId = z.object({ studentId: z.string().uuid().optional().describe('Defaults to the caller if they are a student.') });
const dateRange = z.object({ from: z.string().date().optional(), to: z.string().date().optional() });

export const TOOLS: ToolDef[] = [
  {
    name: 'get_current_user',
    description: "Get the caller's own profile: name, roles, department/section scope, and permissions.",
    parameters: { type: 'object', properties: {} },
    schema: empty,
    isWrite: false,
    run: async (_args, ctx) => {
      const { data, error } = await ctx.db.rpc('my_profile');
      if (error) throw error;
      return data;
    },
  },
  {
    name: 'get_student_profile',
    description: 'Get a student\'s profile (register number, section, course, mentor, class in-charge). Omit studentId to mean "myself".',
    parameters: { type: 'object', properties: { studentId: { type: 'string', description: 'Student UUID. Omit for the caller\'s own profile.' } } },
    schema: withStudentId,
    isWrite: false,
    run: async (args, ctx) => {
      const { studentId } = withStudentId.parse(args);
      let query = ctx.db.from('students').select('id, register_number, roll_number, year, batch, status, department_id, course_id, section_id, mentor_id, class_incharge_id');
      query = studentId ? query.eq('id', studentId) : query.eq('user_id', ctx.userId);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return data ?? { error: 'NOT_FOUND', message: 'No such student, or you are not authorized to view them.' };
    },
  },
  {
    name: 'get_student_attendance',
    description: 'Get a student\'s attendance records, optionally within a date range (YYYY-MM-DD). Omit studentId to mean "myself".',
    parameters: {
      type: 'object',
      properties: {
        studentId: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
    schema: withStudentId.merge(dateRange),
    isWrite: false,
    run: async (args, ctx) => {
      const { studentId, from, to } = withStudentId.merge(dateRange).parse(args);
      let resolvedId = studentId;
      if (!resolvedId) {
        const { data: self } = await ctx.db.from('students').select('id').eq('user_id', ctx.userId).maybeSingle();
        resolvedId = self?.id;
      }
      if (!resolvedId) return { error: 'NOT_FOUND', message: 'No student record for this caller — pass studentId explicitly.' };

      let query = ctx.db
        .from('attendance_records')
        .select('status, sample_count, distance_m, verified_at, is_manual, override_reason, class_sessions(session_date, subject_id, section_id, subjects(name), sections(name))')
        .eq('student_id', resolvedId)
        .order('created_at', { ascending: false })
        .limit(100);
      // class_sessions is a joined table, so date filtering happens via its own column through the FK relation.
      if (from) query = query.gte('class_sessions.session_date', from);
      if (to) query = query.lte('class_sessions.session_date', to);

      const { data, error } = await query;
      if (error) throw error;
      return { studentId: resolvedId, records: data };
    },
  },
  {
    name: 'get_class_attendance',
    description: 'Get aggregated attendance stats for a section+subject (present/absent/late counts and present rate).',
    parameters: { type: 'object', properties: { sectionId: { type: 'string' }, subjectId: { type: 'string' } }, required: ['sectionId'] },
    schema: z.object({ sectionId: z.string().uuid(), subjectId: z.string().uuid().optional() }),
    isWrite: false,
    run: async (args, ctx) => {
      const { sectionId, subjectId } = z.object({ sectionId: z.string().uuid(), subjectId: z.string().uuid().optional() }).parse(args);
      let query = ctx.db.from('report_section_attendance_stats').select('*').eq('section_id', sectionId);
      if (subjectId) query = query.eq('subject_id', subjectId);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  },
  {
    name: 'get_department_attendance',
    description: 'Get aggregated attendance stats for an entire department.',
    parameters: { type: 'object', properties: { departmentId: { type: 'string' } }, required: ['departmentId'] },
    schema: z.object({ departmentId: z.string().uuid() }),
    isWrite: false,
    run: async (args, ctx) => {
      const { departmentId } = z.object({ departmentId: z.string().uuid() }).parse(args);
      const { data, error } = await ctx.db.from('report_department_attendance_stats').select('*').eq('department_id', departmentId).maybeSingle();
      if (error) throw error;
      return data ?? { error: 'NOT_FOUND', message: 'No attendance data for that department (or not authorized).' };
    },
  },
  {
    name: 'get_timetable',
    description: 'Get the weekly timetable for a section, or the caller\'s own section if the caller is a student.',
    parameters: { type: 'object', properties: { sectionId: { type: 'string' } } },
    schema: z.object({ sectionId: z.string().uuid().optional() }),
    isWrite: false,
    run: async (args, ctx) => {
      const { sectionId } = z.object({ sectionId: z.string().uuid().optional() }).parse(args);
      let resolvedSection = sectionId;
      if (!resolvedSection) {
        const { data: self } = await ctx.db.from('students').select('section_id').eq('user_id', ctx.userId).maybeSingle();
        resolvedSection = self?.section_id ?? undefined;
      }
      if (!resolvedSection) return { error: 'NOT_FOUND', message: 'No section resolved — pass sectionId explicitly.' };
      const { data, error } = await ctx.db
        .from('timetable_entries')
        .select('day, start_time, end_time, subjects(name), faculty(id, users(full_name)), classrooms(name)')
        .eq('section_id', resolvedSection)
        .eq('status', 'ACTIVE')
        .order('day')
        .order('start_time');
      if (error) throw error;
      return data;
    },
  },
  {
    name: 'get_class_sessions',
    description: 'Get class sessions (individual activations of a timetable slot on a specific date) for a section within a date range.',
    parameters: { type: 'object', properties: { sectionId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['sectionId'] },
    schema: z.object({ sectionId: z.string().uuid() }).merge(dateRange),
    isWrite: false,
    run: async (args, ctx) => {
      const { sectionId, from, to } = z.object({ sectionId: z.string().uuid() }).merge(dateRange).parse(args);
      let query = ctx.db.from('class_sessions').select('id, session_date, scheduled_start, scheduled_end, status, subjects(name)').eq('section_id', sectionId).order('session_date', { ascending: false }).limit(50);
      if (from) query = query.gte('session_date', from);
      if (to) query = query.lte('session_date', to);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  },
  {
    name: 'get_student_geofence_status',
    description: 'Get a student\'s current campus-presence state (INSIDE_CAMPUS, OUTSIDE_CAMPUS, etc.) — never raw GPS coordinates.',
    parameters: { type: 'object', properties: { studentId: { type: 'string' } } },
    schema: withStudentId,
    isWrite: false,
    run: async (args, ctx) => {
      const { studentId } = withStudentId.parse(args);
      let resolvedId = studentId;
      if (!resolvedId) {
        const { data: self } = await ctx.db.from('students').select('id').eq('user_id', ctx.userId).maybeSingle();
        resolvedId = self?.id;
      }
      if (!resolvedId) return { error: 'NOT_FOUND', message: 'No student record resolved.' };
      const { data, error } = await ctx.db.from('student_presence_state').select('state, state_changed_at').eq('student_id', resolvedId).maybeSingle();
      if (error) throw error;
      return data ?? { state: 'UNKNOWN', state_changed_at: null };
    },
  },
  {
    name: 'get_student_exit_events',
    description: 'Get a student\'s early-exit event history (confirmed campus exits and re-entries).',
    parameters: { type: 'object', properties: { studentId: { type: 'string' } } },
    schema: withStudentId,
    isWrite: false,
    run: async (args, ctx) => {
      const { studentId } = withStudentId.parse(args);
      let resolvedId = studentId;
      if (!resolvedId) {
        const { data: self } = await ctx.db.from('students').select('id').eq('user_id', ctx.userId).maybeSingle();
        resolvedId = self?.id;
      }
      if (!resolvedId) return { error: 'NOT_FOUND', message: 'No student record resolved.' };
      const { data, error } = await ctx.db
        .from('early_exit_events')
        .select('exit_confirmed_at, verification_state, re_entered_at')
        .eq('student_id', resolvedId)
        .order('exit_confirmed_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search approved institutional knowledge documents (CIMS documentation) for the closest-matching passages to a question.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    schema: z.object({ query: z.string().min(1) }),
    isWrite: false,
    run: async (args, ctx) => {
      const { query } = z.object({ query: z.string().min(1) }).parse(args);

      // Embedding requires a provider that supports it (Gemini does; the
      // fixture provider does not) — a typed, honest answer rather than a
      // crash when KAREN_PROVIDER=fixture or the embed call itself fails.
      if (!ctx.embed) {
        return { error: 'EMBEDDING_NOT_CONFIGURED', message: 'The active KAREN_PROVIDER has no embedding backend configured, so search_knowledge cannot run right now.' };
      }

      let vector: number[];
      try {
        vector = await ctx.embed(query);
      } catch (err) {
        return { error: 'EMBEDDING_FAILED', message: err instanceof Error ? err.message : String(err) };
      }

      const { data, error } = await ctx.db.rpc('match_knowledge_chunks', { p_query_embedding: vector as never, p_match_count: 5 });
      if (error) throw error;

      if (!data || data.length === 0) {
        // Distinguish "nothing indexed yet" from "indexed, but nothing
        // matched" — docs/08's "no fabricated confidence" rule applies to
        // this gap too: a silent [] reads as "I searched and found
        // nothing", when the truer statement may be "there is nothing to
        // search yet" (npm run karen:reindex has never been run).
        const { data: indexed } = await ctx.db.rpc('karen_knowledge_is_indexed');
        return indexed
          ? { results: [], message: 'No indexed passage is a close match for this question.' }
          : { error: 'KNOWLEDGE_BASE_NOT_INDEXED', message: 'The knowledge base has not been indexed yet (run scripts/reindex-knowledge.mjs). KAREN cannot search institutional documentation until then.' };
      }

      return { results: data };
    },
  },
  {
    name: 'get_document',
    description: 'Get the status/metadata of a previously requested generated document.',
    parameters: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'] },
    schema: z.object({ documentId: z.string().uuid() }),
    isWrite: false,
    run: async (args, ctx) => {
      const { documentId } = z.object({ documentId: z.string().uuid() }).parse(args);
      const { data, error } = await ctx.db.from('documents').select('id, template_id, entity_type, entity_id, format, status, failed_reason, created_at').eq('id', documentId).maybeSingle();
      if (error) throw error;
      return data ?? { error: 'NOT_FOUND', message: 'No such document, or you are not authorized to view it.' };
    },
  },
  {
    name: 'generate_report',
    description: 'NOT YET IMPLEMENTED as a KAREN action — use the Reports screen. KAREN can answer attendance-rate questions directly via get_class_attendance/get_department_attendance instead.',
    parameters: { type: 'object', properties: {} },
    schema: empty,
    isWrite: true,
    run: () => Promise.resolve(NOT_IMPLEMENTED('generate_report', 'Phase 17 (KAREN confirmations for write actions)')),
  },
  {
    name: 'generate_document',
    description: 'NOT YET IMPLEMENTED as a KAREN action — document generation today runs from the Documents screen only, not from an Edge Function.',
    parameters: { type: 'object', properties: {} },
    schema: empty,
    isWrite: true,
    run: () => Promise.resolve(NOT_IMPLEMENTED('generate_document', 'Phase 17 (KAREN confirmations for write actions)')),
  },
  {
    name: 'get_notifications',
    description: 'Get the caller\'s recent notifications.',
    parameters: { type: 'object', properties: { unreadOnly: { type: 'boolean' } } },
    schema: z.object({ unreadOnly: z.boolean().optional() }),
    isWrite: false,
    run: async (args, ctx) => {
      const { unreadOnly } = z.object({ unreadOnly: z.boolean().optional() }).parse(args);
      let query = ctx.db.from('notifications').select('id, type, title, message, read_at, created_at').eq('recipient_id', ctx.userId).order('created_at', { ascending: false }).limit(20);
      if (unreadOnly) query = query.is('read_at', null);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  },
  {
    name: 'notify_student',
    description: 'Send a notification to a specific student you already have visibility into (someone you teach, mentor, or otherwise have reach to — never an arbitrary student). Requires the user to confirm before it actually sends.',
    parameters: {
      type: 'object',
      properties: {
        studentId: { type: 'string', description: 'The student UUID (get it via get_student_profile if you only have a name).' },
        title: { type: 'string', description: 'Short notification title, e.g. "Class rescheduled".' },
        message: { type: 'string', description: 'The notification body.' },
      },
      required: ['studentId', 'title', 'message'],
    },
    schema: z.object({ studentId: z.string().uuid(), title: z.string().min(1).max(200), message: z.string().min(1).max(1000) }),
    isWrite: true,
    requiresConfirmation: true,
    describe: (args) => {
      const { title, message } = z.object({ studentId: z.string().uuid(), title: z.string(), message: z.string() }).parse(args);
      return `Send a notification titled "${title}" — "${message}"`;
    },
    run: async (args, ctx) => {
      const { studentId, title, message } = z.object({ studentId: z.string().uuid(), title: z.string().min(1).max(200), message: z.string().min(1).max(1000) }).parse(args);
      // Re-checks reachability itself (karen_send_notification is
      // SECURITY DEFINER) — this call is defense in depth, not the only
      // check, matching 20260101002500_karen_confirmations.sql's own
      // comment on why it re-derives students_select_scoped.
      const { data, error } = await ctx.db.rpc('karen_send_notification', { p_student_id: studentId, p_title: title, p_message: message });
      if (error) return { error: 'NOT_AUTHORIZED_OR_NOT_FOUND', message: error.message };
      return { notificationId: data, message: 'Notification sent.' };
    },
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
