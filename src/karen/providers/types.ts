/**
 * Frontend-facing type contract for KAREN (docs/22 ADR-004 names this path).
 *
 * This is deliberately NOT the provider abstraction itself — that lives
 * entirely server-side in `supabase/functions/karen-chat/providers/`, since
 * ADR-004's whole point is that the browser never imports an AI SDK or
 * holds a model key. What the browser needs is just the shape of what the
 * `karen-chat` Edge Function accepts and returns, which is what this file
 * describes, kept in sync with that function's `requestSchema`/response.
 */

export interface KarenChatRequest {
  conversationId?: string;
  message: string;
}

export interface KarenChatResponse {
  conversationId: string;
  reply: string;
  requestId: string;
}

export interface KarenChatErrorResponse {
  error: string;
  message: string;
}

export type KarenMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface KarenMessage {
  id: string;
  role: KarenMessageRole;
  content: string | null;
  tool_name: string | null;
  created_at: string;
}
