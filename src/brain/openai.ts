/**
 * Any service with an OpenAI-style chat API: Groq (free tier, used for the
 * hosted version), and others that copy the same format.
 *
 * Talks to `<baseUrl>/chat/completions` with function tools. Groq's endpoint is
 * https://api.groq.com/openai/v1 and needs GROQ_API_KEY; its tool-capable
 * models are listed at https://console.groq.com/docs/tool-use/overview.
 */

import type { Brain, BrainReply, BrainRequest, ChatMessage } from './types.ts';

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const TIMEOUT_MS = 60_000;

export class OpenAICompatibleBrain implements Brain {
  readonly name: string;

  constructor(
    private readonly service: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.name = `${service}:${model}`;
  }

  async respond({ system, messages, tools }: BrainRequest): Promise<BrainReply> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'system', content: system }, ...toOpenAI(messages)],
          ...(tools.length > 0 && {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error(`Could not reach ${this.service}. Check the server's internet connection.`);
    }
    if (!res.ok) throw new Error(await describeError(this.service, res));

    const body = (await res.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null; tool_calls?: WireToolCall[] } }>;
    };
    const choice = body.choices?.[0];
    const message = choice?.message ?? {};
    if (message.refusal) return { text: message.refusal, toolCalls: [], refused: true };

    // A reply cut off at the length limit may hold a half-written tool call: never run it.
    const toolCalls =
      choice?.finish_reason === 'length'
        ? []
        : (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: parseArguments(c.function.arguments) }));
    return { text: message.content ?? '', toolCalls };
  }
}

/** Neutral history → OpenAI-style messages. */
export function toOpenAI(messages: ChatMessage[]): WireMessage[] {
  return messages.map((m): WireMessage => {
    switch (m.role) {
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant':
        return m.toolCalls?.length
          ? {
              role: 'assistant',
              content: m.content || null,
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }
          : { role: 'assistant', content: m.content };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

/** Turns an error response into a sentence a person can act on. */
async function describeError(service: string, res: Response): Promise<string> {
  const detail = await res.text();
  let message = detail;
  try {
    message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? detail;
  } catch {
    // not JSON
  }
  if (res.status === 401) return `${service} rejected the API key. Check it in the server's settings.`;
  if (res.status === 429) {
    const wait = res.headers.get('retry-after');
    return `${service}'s free limit is used up for the moment. Try again ${wait ? `in ${wait} seconds` : 'in a minute'}.`;
  }
  return `${service} returned ${res.status}: ${message.slice(0, 300)}`;
}

/** Arguments arrive as a JSON string; a model may send a malformed one. */
function parseArguments(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
