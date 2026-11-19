// Provider abstraction (docs/22 ADR-004): karen-chat's orchestration logic
// never talks to a specific vendor SDK directly. Every backend implements
// this same interface; switching KAREN_PROVIDER is a config change, not a
// code change here.

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema (subset) describing the tool's arguments — passed straight through to the provider's function-calling API. */
  parameters: Record<string, unknown>;
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Only set on role='tool' messages replaying a prior tool call/result back to the model. */
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
}

/** What the provider decided to do this turn. Exactly one of the two shapes. */
export type ProviderTurn =
  | { kind: 'message'; content: string }
  | { kind: 'tool_call'; toolName: string; args: unknown };

export interface ProviderRequest {
  systemPrompt: string;
  history: ChatMessage[];
  tools: ToolSchema[];
  signal?: AbortSignal;
}

export interface Provider {
  readonly name: string;
  generate(req: ProviderRequest): Promise<ProviderTurn>;
}

/** Thrown by a provider (or the orchestration loop) for a caller-visible, typed failure — never a fabricated response. */
export class ProviderError extends Error {
  constructor(
    public readonly code:
      | 'PROVIDER_NOT_CONFIGURED'
      | 'PROVIDER_REQUEST_FAILED'
      | 'PROVIDER_INVALID_RESPONSE'
      | 'RATE_LIMITED',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
