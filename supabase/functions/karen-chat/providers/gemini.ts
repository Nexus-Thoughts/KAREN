// Gemini provider — the only backend actually wired to a real vendor, per
// docs/00 (IRIS's own geminiService.ts used Gemini, so this keeps parity)
// and the user's explicit choice of Gemini for KAREN's first real provider.
//
// This calls the public Generative Language REST API directly (no
// @google/genai SDK dependency — Deno Edge Functions keep their own
// dependency surface small, and the REST shape is simple enough not to need
// it). The API key is read once, in index.ts, from Edge Function secrets
// (KAREN_API_KEY) and passed in here — it is never sent to, or readable by,
// the browser (ADR-004).
import type { Provider, ProviderRequest, ProviderTurn, ChatMessage } from './types.ts';
import { ProviderError } from './types.ts';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Phase 19 (Security Hardening). The Gemini REST API takes its key as a
// `?key=...` query parameter (there's no header-based auth option), so the
// full request URL — key included — sits inside `res.url`, and, on a
// network-level failure, inside the underlying HTTP client's own thrown
// error message (Deno's fetch surfaces the request URL verbatim in that
// case, e.g. "error sending request for url (...?key=AIzaSy...)"). Every
// ProviderError message constructed in this file is returned straight to
// the browser as the chat's error response (karen-chat/index.ts), and,
// since Phase 18, also written into audit_logs — so any string that might
// contain the raw key must be redacted before it becomes a ProviderError,
// not after. This is defense in depth for the response-body `detail` case
// too: no known Gemini error body echoes the key back today, but nothing
// guarantees that stays true.
function redactKey(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join('[REDACTED]') : message;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

function toGeminiContents(history: ChatMessage[]): Array<{ role: string; parts: GeminiPart[] }> {
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  for (const m of history) {
    if (m.role === 'system') continue; // carried separately as systemInstruction
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      contents.push({ role: 'model', parts: [{ text: m.content }] });
    } else if (m.role === 'tool') {
      // Gemini expects the function call itself as a preceding 'model' turn
      // and the result as a 'function' turn — both are replayed here from
      // what was actually persisted (karen_messages), never re-invented.
      contents.push({
        role: 'model',
        parts: [{ functionCall: { name: m.toolName ?? 'unknown_tool', args: (m.toolArgs as Record<string, unknown>) ?? {} } }],
      });
      contents.push({
        role: 'function',
        parts: [{ functionResponse: { name: m.toolName ?? 'unknown_tool', response: (m.toolResult as Record<string, unknown>) ?? {} } }],
      });
    }
  }
  return contents;
}

// Embeddings (Phase 16 — KAREN RAG). Separate from the chat `generate()`
// call above: this hits `:embedContent` on a fixed embedding model, not the
// chat model, and returns a plain vector rather than a ProviderTurn — used
// by the search_knowledge tool (tools.ts) to turn the caller's question
// into the same 768-dimension space scripts/reindex-knowledge.mjs embedded
// docs/ into (karen_knowledge_rag migration's `vector(768)` columns).
const EMBEDDING_MODEL = 'text-embedding-004';

export async function embedText(apiKey: string, text: string, signal?: AbortSignal): Promise<number[]> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
      signal,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new ProviderError('PROVIDER_REQUEST_FAILED', `Could not reach Gemini embeddings: ${redactKey(raw, apiKey)}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ProviderError('PROVIDER_REQUEST_FAILED', `Gemini embeddings returned ${res.status}. Detail: ${redactKey(detail.slice(0, 300), apiKey)}`);
  }

  const data = await res.json().catch(() => null) as { embedding?: { values?: number[] } } | null;
  const values = data?.embedding?.values;
  if (!values || values.length === 0) {
    throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'Gemini embeddings returned no vector.');
  }
  return values;
}

export function createGeminiProvider(apiKey: string, model: string): Provider {
  return {
    name: 'gemini',
    async generate(req: ProviderRequest): Promise<ProviderTurn> {
      const body = {
        systemInstruction: { role: 'system', parts: [{ text: req.systemPrompt }] },
        contents: toGeminiContents(req.history),
        tools: req.tools.length > 0
          ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }]
          : undefined,
      };

      let res: Response;
      try {
        res = await fetch(`${API_BASE}/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        throw new ProviderError('PROVIDER_REQUEST_FAILED', `Could not reach Gemini: ${redactKey(raw, apiKey)}`);
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ProviderError(
          'PROVIDER_REQUEST_FAILED',
          `Gemini returned ${res.status}. This usually means KAREN_API_KEY is missing, revoked, or not a valid Gemini API key (a real key from https://aistudio.google.com/apikey normally starts with "AIza"). Detail: ${redactKey(detail.slice(0, 300), apiKey)}`,
        );
      }

      const data = await res.json().catch(() => null) as {
        candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
      } | null;

      const parts = data?.candidates?.[0]?.content?.parts;
      if (!parts || parts.length === 0) {
        throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'Gemini returned no candidates.');
      }

      const call = parts.find((p) => p.functionCall);
      if (call?.functionCall) {
        return { kind: 'tool_call', toolName: call.functionCall.name, args: call.functionCall.args ?? {} };
      }

      const text = parts.map((p) => p.text ?? '').join('').trim();
      if (!text) throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'Gemini returned an empty response.');
      return { kind: 'message', content: text };
    },
  };
}
