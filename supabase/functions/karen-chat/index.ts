// karen-chat — KAREN's entire HTTP surface (docs/22 ADR-004). The browser
// never imports an AI SDK or holds a model key; it calls this one Edge
// Function via supabase.functions.invoke('karen-chat', ...), which:
//
//   1. authenticates the caller from their own Supabase session JWT (never
//      the service role — every DB query below runs AS the calling user, so
//      RLS is the real authorization boundary for every tool KAREN uses,
//      matching docs/08 "no RBAC bypass");
//   2. enforces the per-minute rate limit (KAREN_RATE_LIMIT_PER_MINUTE)
//      before spending a provider call;
//   3. persists the conversation (public.karen_conversations/karen_messages);
//   4. runs a bounded tool-call loop against the configured provider
//      (KAREN_PROVIDER — 'gemini' or 'fixture'; docs/22 ADR-004: a missing
//      key returns a typed PROVIDER_NOT_CONFIGURED error, never a fabricated
//      reply);
//   5. audits every tool call via public.karen_log_tool_call (Phase 15).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';
import { z } from 'npm:zod@3.24.1';
import { fixtureProvider } from './providers/fixture.ts';
import { createGeminiProvider, embedText } from './providers/gemini.ts';
import { ProviderError, type ChatMessage, type Provider } from './providers/types.ts';
import { TOOLS, findTool } from './tools.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!;
const KAREN_PROVIDER = Deno.env.get('KAREN_PROVIDER') ?? 'fixture';
const KAREN_MODEL = Deno.env.get('KAREN_MODEL') || 'gemini-2.0-flash';
const KAREN_API_KEY = Deno.env.get('KAREN_API_KEY') ?? '';
const KAREN_RATE_LIMIT_PER_MINUTE = Number(Deno.env.get('KAREN_RATE_LIMIT_PER_MINUTE') ?? '20');
const KAREN_REQUEST_TIMEOUT_MS = Number(Deno.env.get('KAREN_REQUEST_TIMEOUT_MS') ?? '60000');

const MAX_TOOL_LOOPS = 4; // bounded — KAREN must terminate, never loop forever chasing tool calls.

// Phase 19 (Security Hardening). Every Supabase Edge Function is
// cross-origin from the app (the app runs on its own host; the function on
// *.supabase.co), and supabase-js's functions.invoke() sends an
// Authorization header — a non-"simple" header — so the browser always
// sends a CORS preflight (OPTIONS) first. Before this, the function had no
// OPTIONS handling at all: `req.method !== 'POST'` returned 405 for the
// preflight itself, which means every call from an actual browser (not curl)
// would have failed outright. CORS is purely a browser-transport concern
// here, never the authorization boundary — that is still the caller's own
// JWT plus RLS on every table, exactly as in the rest of this file — so a
// permissive origin is fine: it widens who can *ask*, not what a legitimate
// answer contains.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `You are KAREN, the assistant inside CIMS (College Intelligent Management System).
Rules you must never break:
- Use tools for any live/authoritative data question (attendance, timetable, geofence status, notifications, documents). Never guess or invent institutional data.
- You only ever see what the calling user is authorized to see — every tool is scoped to them. If a tool returns NOT_FOUND or a permission-style message, tell the user plainly; do not work around it.
- Never disclose a student's raw GPS coordinates — only the presence state a tool returns (e.g. INSIDE_CAMPUS).
- If a tool is not implemented yet, say so plainly and suggest the relevant screen in CIMS instead of fabricating an answer.
Be concise and factual.`;

// Phase 17 — KAREN confirmations for write actions. Exactly one of
// `message` (a normal chat turn) or `confirmActionId` (the user clicked
// Confirm on a previously proposed write — see tools.ts's
// requiresConfirmation and karen_pending_actions,
// 20260101002500_karen_confirmations.sql) is present on any given request;
// never both, never neither.
const requestSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    message: z.string().min(1).max(4000).optional(),
    confirmActionId: z.string().uuid().optional(),
  })
  .refine((b) => (b.message ? !b.confirmActionId : !!b.confirmActionId), {
    message: 'Provide exactly one of "message" or "confirmActionId".',
  });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}

function selectProvider(): Provider {
  if (KAREN_PROVIDER === 'gemini') {
    if (!KAREN_API_KEY) {
      throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'KAREN_PROVIDER=gemini but KAREN_API_KEY is not set in this Edge Function\'s secrets.');
    }
    return createGeminiProvider(KAREN_API_KEY, KAREN_MODEL);
  }
  if (KAREN_PROVIDER === 'fixture') return fixtureProvider;
  throw new ProviderError('PROVIDER_NOT_CONFIGURED', `Unknown KAREN_PROVIDER "${KAREN_PROVIDER}".`);
}

async function loadHistory(db: SupabaseClient, conversationId: string): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('karen_messages')
    .select('role, content, tool_name, tool_args, tool_result')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(40);
  if (error) throw error;
  return (data ?? []).map((m) => ({
    role: m.role as ChatMessage['role'],
    content: m.content ?? '',
    toolName: m.tool_name ?? undefined,
    toolArgs: m.tool_args ?? undefined,
    toolResult: m.tool_result ?? undefined,
  }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);

  // Phase 18 (Observability). Measured from here (not inside the tool loop
  // below) so it covers the whole request — including the auth/rate-limit/
  // provider-selection failures that, before this phase, left zero trace in
  // audit_logs even though every successful tool call was logged.
  const requestStartedAt = performance.now();

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonResponse({ error: 'UNAUTHENTICATED', message: 'Missing Authorization header.' }, 401);

  // Scoped to the caller: every query this client makes is subject to that
  // user's RLS policies, exactly like a normal PostgREST request from the
  // browser would be. This is the whole of ADR-004/docs/08's "no RBAC
  // bypass" guarantee for KAREN — there is no service-role client anywhere
  // in this function.
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await db.auth.getUser();
  if (userErr || !userData?.user) return jsonResponse({ error: 'UNAUTHENTICATED', message: 'Invalid or expired session.' }, 401);
  const userId = userData.user.id;

  // One id per request, used both to correlate every audit_logs row this
  // request produces (tool calls, and — since Phase 18 — its own failure,
  // if it has one) and returned to the client for support/debugging.
  const requestId = crypto.randomUUID();

  // Phase 18 — records a request that failed before or between tool calls
  // (rate limited, provider unavailable, an unexpected exception) as its
  // own audit_logs row, using the '_request' sentinel tool name so it is
  // never mistaken for a real tools.ts entry. Best-effort: a logging
  // failure must never mask or replace the real error being reported to
  // the caller.
  const logRequestFailure = async (code: string, message: string) => {
    try {
      await db.rpc('karen_log_tool_call', {
        p_tool_name: '_request',
        p_args: {},
        p_result: { error: code, message },
        p_is_write: false,
        p_request_id: requestId,
        p_duration_ms: Math.round(performance.now() - requestStartedAt),
      });
    } catch {
      // Swallow — see comment above.
    }
  };

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await req.json());
  } catch (err) {
    return jsonResponse({ error: 'INVALID_REQUEST', message: err instanceof Error ? err.message : String(err) }, 400);
  }

  // Confirmation branch: the user clicked Confirm on a previously proposed
  // write action. This never touches the provider or the tool-call loop
  // below — the tool was already chosen and its arguments already fixed
  // when the action was proposed; confirming only ever executes exactly
  // that, never a fresh decision the model makes now (docs/08: a
  // confirmation confirms a specific proposed action, not "go ahead and do
  // something roughly like this").
  if (body.confirmActionId) {
    const { data: pending, error: pendingErr } = await db
      .from('karen_pending_actions')
      .select('id, conversation_id, tool_name, args, summary, expires_at, consumed_at')
      .eq('id', body.confirmActionId)
      .maybeSingle();
    if (pendingErr) return jsonResponse({ error: 'INTERNAL', message: pendingErr.message }, 500);
    // RLS (karen_pending_actions_own) already means a `.maybeSingle()` miss
    // here covers both "never existed" and "belongs to someone else" —
    // deliberately the same NOT_FOUND either way, not a 403 that would leak
    // which case it was.
    if (!pending) return jsonResponse({ error: 'NOT_FOUND', message: 'No such pending action.' }, 404);
    if (pending.consumed_at) return jsonResponse({ error: 'ALREADY_CONSUMED', message: 'This action was already confirmed or cancelled.' }, 409);
    if (new Date(pending.expires_at).getTime() < Date.now()) {
      return jsonResponse({ error: 'EXPIRED', message: 'This confirmation has expired — ask KAREN again to propose it fresh.' }, 409);
    }

    const tool = findTool(pending.tool_name);
    let result: unknown;
    if (!tool) {
      result = { error: 'UNKNOWN_TOOL', message: `"${pending.tool_name}" is not a recognised KAREN tool.` };
    } else {
      try {
        const parsedArgs = tool.schema.parse(pending.args);
        result = await tool.run(parsedArgs, { db, userId, embed: undefined });
      } catch (err) {
        result = { error: 'TOOL_FAILED', message: err instanceof Error ? err.message : String(err) };
      }
    }

    // Consume before logging/replying — if a client retries this exact
    // request (double-click, network retry), the second call must land on
    // the ALREADY_CONSUMED branch above, never execute the write twice.
    await db.from('karen_pending_actions').update({ consumed_at: new Date().toISOString() }).eq('id', pending.id);

    await db.rpc('karen_log_tool_call', {
      p_tool_name: pending.tool_name,
      p_args: pending.args,
      p_result: result,
      p_is_write: true,
      p_request_id: requestId,
      p_duration_ms: Math.round(performance.now() - requestStartedAt),
    });

    const resultObj = result as { error?: string; message?: string } | null;
    const replyText = resultObj?.error
      ? `That didn't go through: ${resultObj.message ?? resultObj.error}`
      : `Done — ${pending.summary}`;

    await db.from('karen_messages').insert({
      conversation_id: pending.conversation_id,
      role: 'tool',
      tool_name: pending.tool_name,
      tool_args: pending.args,
      tool_result: result as never,
    });
    await db.from('karen_messages').insert({ conversation_id: pending.conversation_id, role: 'assistant', content: replyText });
    await db.from('karen_conversations').update({ updated_at: new Date().toISOString() }).eq('id', pending.conversation_id);

    return jsonResponse({ conversationId: pending.conversation_id, reply: replyText, confirmed: true });
  }

  // The schema's refine() guarantees exactly one of message/confirmActionId
  // is set; the confirmActionId branch above always returns, so `message`
  // is definitely a string on every path from here on — this const (rather
  // than `message!` scattered below) is where that gets asserted once.
  const message: string = body.message!;

  const { data: rateOk, error: rateErr } = await db.rpc('karen_check_rate_limit', { p_limit_per_minute: KAREN_RATE_LIMIT_PER_MINUTE });
  if (rateErr) {
    await logRequestFailure('INTERNAL', rateErr.message);
    return jsonResponse({ error: 'INTERNAL', message: rateErr.message }, 500);
  }
  if (rateOk === false) {
    const message = `You've sent more than ${KAREN_RATE_LIMIT_PER_MINUTE} messages in the last minute. Please wait a moment.`;
    await logRequestFailure('RATE_LIMITED', message);
    return jsonResponse({ error: 'RATE_LIMITED', message }, 429);
  }

  let provider: Provider;
  try {
    provider = selectProvider();
  } catch (err) {
    if (err instanceof ProviderError) {
      await logRequestFailure(err.code, err.message);
      return jsonResponse({ error: err.code, message: err.message }, 503);
    }
    throw err;
  }

  // Only Gemini has an embedding backend wired up (providers/gemini.ts) —
  // search_knowledge (tools.ts) checks for undefined and returns a typed
  // message rather than the fixture provider silently returning nothing
  // meaningful.
  const embedForTools: ((text: string) => Promise<number[]>) | undefined =
    KAREN_PROVIDER === 'gemini' && KAREN_API_KEY ? (text: string) => embedText(KAREN_API_KEY, text) : undefined;

  // Resolve/create the conversation. Declared without an initializer and
  // assigned exactly once on every reachable path below, so TS's definite-
  // assignment analysis gives it type `string` (not `string | undefined`)
  // from here on — every early return above happens before a provider call
  // is made or anything is persisted, so nothing is spent on a request that
  // turns out to be for a nonexistent conversation.
  let conversationId: string;
  if (body.conversationId) {
    const { data: convo, error: convoErr } = await db.from('karen_conversations').select('id').eq('id', body.conversationId).maybeSingle();
    if (convoErr) return jsonResponse({ error: 'INTERNAL', message: convoErr.message }, 500);
    if (!convo) return jsonResponse({ error: 'NOT_FOUND', message: 'Conversation not found.' }, 404);
    conversationId = body.conversationId;
  } else {
    const { data: created, error: createErr } = await db
      .from('karen_conversations')
      .insert({ user_id: userId, title: message.slice(0, 80) })
      .select('id')
      .single();
    if (createErr) return jsonResponse({ error: 'INTERNAL', message: createErr.message }, 500);
    conversationId = created.id;
  }

  const { error: insertUserMsgErr } = await db.from('karen_messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content: message,
  });
  if (insertUserMsgErr) return jsonResponse({ error: 'INTERNAL', message: insertUserMsgErr.message }, 500);

  const history = await loadHistory(db, conversationId);
  const toolSchemas = TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), KAREN_REQUEST_TIMEOUT_MS);

  try {
    let loops = 0;
    let finalText: string | null = null;
    let pendingConfirmation: { id: string; summary: string } | null = null;

    while (loops < MAX_TOOL_LOOPS && finalText === null) {
      loops += 1;
      const loopStartedAt = performance.now();
      let turn;
      try {
        turn = await provider.generate({ systemPrompt: SYSTEM_PROMPT, history, tools: toolSchemas, signal: timeoutController.signal });
      } catch (err) {
        if (err instanceof ProviderError) {
          await logRequestFailure(err.code, err.message);
          return jsonResponse({ error: err.code, message: err.message }, 502);
        }
        throw err;
      }

      if (turn.kind === 'message') {
        finalText = turn.content;
        break;
      }

      // tool_call
      const tool = findTool(turn.toolName);
      let result: unknown;
      if (!tool) {
        result = { error: 'UNKNOWN_TOOL', message: `"${turn.toolName}" is not a recognised KAREN tool.` };
      } else if (tool.requiresConfirmation) {
        // Never runs here — only ever via the confirmActionId branch above,
        // once the user has actually clicked Confirm. This turn just
        // records what WOULD happen and hands the model + frontend a
        // confirmationId to act on (src/features/karen/KarenChatPage.tsx
        // renders it as a Confirm/Cancel affordance).
        try {
          const parsedArgs = tool.schema.parse(turn.args ?? {});
          const summary = tool.describe ? tool.describe(parsedArgs) : `${tool.name}(${JSON.stringify(parsedArgs)})`;
          const { data: pendingRow, error: pendingInsertErr } = await db
            .from('karen_pending_actions')
            .insert({ user_id: userId, conversation_id: conversationId, tool_name: tool.name, args: parsedArgs, summary })
            .select('id')
            .single();
          if (pendingInsertErr) throw pendingInsertErr;
          pendingConfirmation = { id: pendingRow.id, summary };
          result = { status: 'CONFIRMATION_REQUIRED', confirmationId: pendingRow.id, summary };
        } catch (err) {
          result = { error: 'TOOL_FAILED', message: err instanceof Error ? err.message : String(err) };
        }
        // Proposing a write is itself worth a (non-write) audit entry —
        // the write only actually happens, and gets its own AI_WRITE_ACTION
        // row, if and when the confirmActionId branch above runs it.
        await db.rpc('karen_log_tool_call', {
          p_tool_name: tool.name,
          p_args: turn.args ?? {},
          p_result: result,
          p_is_write: false,
          p_request_id: requestId,
          p_duration_ms: Math.round(performance.now() - loopStartedAt),
        });
      } else {
        try {
          const parsedArgs = tool.schema.parse(turn.args ?? {});
          result = await tool.run(parsedArgs, { db, userId, embed: embedForTools });
        } catch (err) {
          result = { error: 'TOOL_FAILED', message: err instanceof Error ? err.message : String(err) };
        }
        // Audit every tool call — success or failure — per docs/09 "audit behavior".
        await db.rpc('karen_log_tool_call', {
          p_tool_name: tool.name,
          p_args: turn.args ?? {},
          p_result: result,
          p_is_write: tool.isWrite,
          p_request_id: requestId,
          p_duration_ms: Math.round(performance.now() - loopStartedAt),
        });
      }

      history.push({ role: 'tool', content: '', toolName: turn.toolName, toolArgs: turn.args, toolResult: result });
      await db.from('karen_messages').insert({
        conversation_id: conversationId,
        role: 'tool',
        tool_name: turn.toolName,
        tool_args: turn.args as never,
        tool_result: result as never,
      });
    }

    if (finalText === null) {
      finalText = "I wasn't able to finish that within the allowed number of steps — please rephrase or ask something narrower.";
    }

    await db.from('karen_messages').insert({ conversation_id: conversationId, role: 'assistant', content: finalText });
    await db.from('karen_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);

    return jsonResponse({ conversationId, reply: finalText, requestId, pendingConfirmation });
  } catch (err) {
    // Phase 18 (Observability) — the backstop. Every *expected* failure mode
    // above already returns its own typed response; this only ever fires
    // for something genuinely unanticipated (an aborted fetch on timeout, an
    // unexpected DB error mid-loop, etc.). Before this existed, such a
    // request left the browser with a bare CORS failure (no
    // Access-Control-Allow-Origin on Deno's own uncaught-exception response)
    // and left zero trace anywhere — the caller couldn't tell KAREN apart
    // from a network outage, and nobody could look it up by requestId
    // afterwards either.
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    const code = isAbort ? 'TIMEOUT' : 'INTERNAL';
    const message = isAbort
      ? `KAREN didn't respond within ${KAREN_REQUEST_TIMEOUT_MS}ms.`
      : err instanceof Error
        ? err.message
        : String(err);
    console.error(`[karen-chat] requestId=${requestId} ${code}: ${message}`);
    await logRequestFailure(code, message);
    return jsonResponse({ error: code, message, requestId }, isAbort ? 504 : 500);
  } finally {
    clearTimeout(timeoutId);
  }
});
