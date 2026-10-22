/**
 * Claude, through the Anthropic API.
 *
 * Needs ANTHROPIC_API_KEY in the environment (the SDK reads it). To use Claude
 * through AWS, Google Cloud or Azure instead, swap the client for that
 * platform's client class; the rest of this file stays the same.
 *
 * Two details that matter for correctness:
 *  - Claude's assistant turns are handed back exactly as received (`raw`),
 *    thinking blocks included, while a tool loop is in progress.
 *  - Server-side refusal fallbacks are on (`fallbacks: "default"`): if a
 *    request is declined, the API retries it on a fallback model in the same
 *    call. A request that is still declined comes back as `refused`.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Brain, BrainReply, BrainRequest, ChatMessage } from './types.ts';

type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type MessageParam = Anthropic.Beta.BetaMessageParam;

export class AnthropicBrain implements Brain {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(
    private readonly model: string,
    client?: Anthropic,
  ) {
    this.name = `anthropic:${model}`;
    this.client = client ?? new Anthropic();
  }

  async respond({ system, messages, tools }: BrainRequest): Promise<BrainReply> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages: toAnthropic(messages),
    });

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (response.stop_reason === 'refusal') {
      return { text: text || 'I can’t help with that request.', toolCalls: [], refused: true };
    }

    // A reply cut off at max_tokens may hold a half-written tool call: never run it.
    const toolCalls =
      response.stop_reason === 'tool_use'
        ? response.content
            .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
            .map((b) => ({ id: b.id, name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> }))
        : [];

    return { text, toolCalls, raw: response.content };
  }
}

/** Neutral history → Anthropic messages. Consecutive tool results share one user turn. */
export function toAnthropic(messages: ChatMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.raw)) {
        out.push({ role: 'assistant', content: m.raw as ContentBlockParam[] });
        continue;
      }
      const content: ContentBlockParam[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      out.push({ role: 'assistant', content });
    } else {
      const result: ContentBlockParam = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const prev = out.at(-1);
      if (prev?.role === 'user' && Array.isArray(prev.content)) {
        prev.content.push(result);
      } else {
        out.push({ role: 'user', content: [result] });
      }
    }
  }
  return out;
}
