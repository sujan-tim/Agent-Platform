/**
 * A scripted brain for tests and offline demos.
 *
 * With a script, it replays the given replies in order. Without one, it
 * follows a simple rule set so the app is usable with no model at all:
 * a question mentioning "time" asks for the clock, "search" or "document"
 * searches the company's documents, "note" saves a note, and anything else
 * is echoed back.
 */

import { randomUUID } from 'node:crypto';
import type { Brain, BrainReply, BrainRequest } from './types.ts';

export class MockBrain implements Brain {
  readonly name = 'mock';
  /** Every request this brain received, so tests can inspect what it was shown. */
  readonly requests: BrainRequest[] = [];

  constructor(private readonly script?: BrainReply[]) {}

  async respond(request: BrainRequest): Promise<BrainReply> {
    this.requests.push(structuredClone(request));
    if (this.script) {
      const next = this.script.shift();
      if (!next) throw new Error('MockBrain script ran out of replies.');
      return next;
    }
    return ruleBased(request);
  }
}

function ruleBased({ messages, tools }: BrainRequest): BrainReply {
  const last = messages.at(-1);
  if (last?.role === 'tool') {
    return { text: `Here is what I found:\n${last.content}`, toolCalls: [] };
  }
  const question = last?.role === 'user' ? last.content : '';
  const offered = new Set(tools.map((t) => t.name));
  const call = (name: string, args: Record<string, unknown>): BrainReply => ({
    text: '',
    toolCalls: [{ id: randomUUID(), name, arguments: args }],
  });

  if (/\btime\b/i.test(question) && offered.has('get_current_time')) return call('get_current_time', {});
  if (/\b(search|document|docs?)\b/i.test(question) && offered.has('search_documents')) {
    return call('search_documents', { query: question });
  }
  if (/\bnote\b/i.test(question) && offered.has('save_note')) return call('save_note', { text: question });
  return { text: `(mock brain) You said: ${question}`, toolCalls: [] };
}
