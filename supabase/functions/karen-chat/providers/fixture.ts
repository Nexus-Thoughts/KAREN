// Deterministic in-repo provider, selected by KAREN_PROVIDER=fixture.
// Used by tests and by any environment that has not configured a real model
// key yet — it never calls out to the network and never fabricates domain
// data; it only ever describes its own fixture behaviour.
import type { Provider, ProviderRequest, ProviderTurn } from './types.ts';

export const fixtureProvider: Provider = {
  name: 'fixture',
  generate(req: ProviderRequest): Promise<ProviderTurn> {
    const lastUser = [...req.history].reverse().find((m) => m.role === 'user');
    const text = lastUser?.content ?? '';

    // A tiny, explicit routing table so pgTAP-adjacent Edge Function tests
    // can assert both branches (plain answer vs. a tool call) without any
    // real model in the loop.
    if (/attendance/i.test(text) && req.tools.some((t) => t.name === 'get_student_attendance')) {
      return Promise.resolve({ kind: 'tool_call', toolName: 'get_student_attendance', args: {} });
    }

    return Promise.resolve({
      kind: 'message',
      content: `[fixture provider] KAREN_PROVIDER=fixture — no real model configured. Received: "${text}".`,
    });
  },
};
