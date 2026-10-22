/**
 * Ollama: a free model running on your own machine.
 *
 * Talks to Ollama's chat endpoint (https://github.com/ollama/ollama/blob/main/docs/api.md).
 * The model must support tool calling — llama3.1, qwen2.5 and mistral-nemo do;
 * pull one first with `ollama pull llama3.1`.
 */

import { randomUUID } from 'node:crypto';
import type { Brain, BrainReply, BrainRequest, ChatMessage } from './types.ts';

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export class OllamaBrain implements Brain {
  readonly name: string;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {
    this.name = `ollama:${model}`;
  }

  async respond({ system, messages, tools }: BrainRequest): Promise<BrainReply> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [{ role: 'system', content: system }, ...messages.map(toOllama)],
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }),
      });
    } catch {
      throw new Error(
        `Could not reach Ollama at ${this.baseUrl}. Is it running? Start the Ollama app, or run \`ollama serve\`.`,
      );
    }
    if (!res.ok) {
      const detail = await res.text();
      if (res.status === 404) {
        throw new Error(`Ollama has no model "${this.model}". Run \`ollama pull ${this.model}\`. (${detail})`);
      }
      throw new Error(`Ollama returned ${res.status}: ${detail}`);
    }

    const body = (await res.json()) as { message?: OllamaMessage };
    const message = body.message ?? { role: 'assistant', content: '' };
    return {
      text: message.content ?? '',
      toolCalls: (message.tool_calls ?? []).map((c) => ({
        // Ollama does not number its tool calls; the loop needs ids to pair results.
        id: randomUUID(),
        name: c.function.name,
        arguments: parseArguments(c.function.arguments),
      })),
    };
  }
}

function toOllama(m: ChatMessage): OllamaMessage {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: m.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls?.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
      };
    case 'tool':
      return { role: 'tool', content: m.content, tool_name: m.name };
  }
}

/** Some models send arguments as a JSON string instead of an object. */
function parseArguments(args: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof args !== 'string') return args ?? {};
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
