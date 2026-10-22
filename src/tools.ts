/**
 * The tools the agent can use, and the gate that decides which it may use.
 *
 * Every tool declares its kind. `read` tools only look things up and are on by
 * default; `write` tools change something and are off until a company admin
 * turns them on. This mirrors Jarvis's read-only default, made per company.
 */

import type { ToolSpec } from './brain/types.ts';
import type { Embedder } from './embed.ts';
import type { Store } from './store.ts';

export interface ToolContext {
  store: Store;
  tenantId: string;
  userId: string;
  /** Present when search by meaning is on. */
  embedder?: Embedder;
}

export interface Tool extends ToolSpec {
  kind: 'read' | 'write';
  run(ctx: ToolContext, args: Record<string, unknown>): string | Promise<string>;
}

export const TOOLS: Tool[] = [
  {
    name: 'get_current_time',
    kind: 'read',
    description: 'Returns the current date and time on the server, in ISO 8601 format and in UTC.',
    parameters: { type: 'object', properties: {} },
    run: () => new Date().toISOString(),
  },
  {
    name: 'search_documents',
    kind: 'read',
    description:
      "Searches the documents this person's company has uploaded (policies, manuals, notes) and returns the most relevant passages with their document titles. Use it whenever a question may be answered by company material.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for, in words or as a question.' } },
      required: ['query'],
    },
    run: async ({ store, tenantId, embedder }, args) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return 'No search query was given.';
      let meaning;
      if (embedder) {
        try {
          meaning = { model: embedder.model, vector: (await embedder.embed([query], 'query'))[0] };
        } catch {
          // Embeddings unavailable right now: keyword search still answers.
        }
      }
      const hits = await store.searchDocuments(tenantId, query, 5, meaning);
      if (hits.length === 0) return 'No matching passages in the company documents.';
      // Wrapped so the model reads it as material, not as instructions to follow.
      return hits
        .map((h) => `<document title="${h.title.replaceAll('"', "'")}">\n${h.excerpt}\n</document>`)
        .join('\n\n');
    },
  },
  {
    name: 'save_note',
    kind: 'write',
    description: 'Saves a short note for this person, for example a reminder or a summary they asked to keep.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The note to save.' } },
      required: ['text'],
    },
    run: async ({ store, tenantId, userId }, args) => {
      const text = typeof args.text === 'string' ? args.text.trim().slice(0, 2000) : '';
      if (!text) return 'Nothing saved: the note was empty.';
      await store.addNote(tenantId, userId, text);
      return 'Note saved.';
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): Tool | undefined {
  return BY_NAME.get(name);
}

/** Whether a company allows a tool: its admin's choice, else on for read tools and off for write tools. */
export function isToolAllowed(tool: Tool, settings: Map<string, boolean>): boolean {
  return settings.get(tool.name) ?? tool.kind === 'read';
}

/** Every tool with its current state for one company, for the admin page. */
export async function toolStates(store: Store, tenantId: string) {
  const settings = await store.getToolSettings(tenantId);
  return TOOLS.map((t) => ({
    name: t.name,
    kind: t.kind,
    description: t.description,
    enabled: isToolAllowed(t, settings),
  }));
}
