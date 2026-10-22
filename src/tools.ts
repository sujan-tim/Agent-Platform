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
import type { WebSearcher } from './websearch.ts';

export interface ToolContext {
  store: Store;
  tenantId: string;
  userId: string;
  /** Present when search by meaning is on. */
  embedder?: Embedder;
  /** Present when the server has a web search service. */
  web?: WebSearcher;
  /** Records a web page the answer may draw on and returns its number, for citing as [n]. */
  cite?: (page: { title: string; url: string }) => number;
}

export interface Tool extends ToolSpec {
  kind: 'read' | 'write';
  /**
   * Set when the tool needs something only some callers have: 'web' a web search
   * service, 'browser' the Chrome extension, which runs browser actions itself.
   */
  needs?: 'web' | 'browser';
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
    name: 'web_search',
    kind: 'read',
    needs: 'web',
    description:
      'Searches the live web and returns the top results with their titles, links, dates and summaries. Use it for anything current or recent (news, prices, people, events, companies) and for anything the company documents do not cover. Set news to true for recent news.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, as you would type it into a search engine.' },
        news: { type: 'boolean', description: 'True to search news articles only.' },
        days: { type: 'integer', description: 'Only results from the last this many days, for recent events.' },
      },
      required: ['query'],
    },
    run: async ({ web, cite }, args) => {
      const query = typeof args.query === 'string' ? args.query.trim().slice(0, 400) : '';
      if (!query) return 'No search query was given.';
      const days = typeof args.days === 'number' && args.days > 0 ? args.days : undefined;
      const results = await web!.search(query, { news: args.news === true, days });
      if (results.length === 0) return 'The web search found nothing for that query.';
      // Wrapped so the model reads it as material, not as instructions to follow.
      return results
        .map((r) => {
          const n = cite ? ` n="${cite(r)}"` : '';
          const published = r.publishedDate ? ` published="${attr(r.publishedDate)}"` : '';
          return `<web_result${n} title="${attr(r.title)}" url="${attr(r.url)}"${published}>\n${r.content}\n</web_result>`;
        })
        .join('\n\n');
    },
  },
  {
    name: 'read_web_page',
    kind: 'read',
    needs: 'web',
    description:
      'Reads the text of one web page, for when search result summaries are not enough. Give a full http or https link, usually one returned by web_search.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full link of the page, starting with http:// or https://.' } },
      required: ['url'],
    },
    run: async ({ web, cite }, args) => {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!/^https?:\/\/\S+$/i.test(url)) return 'Give a full link starting with http:// or https://.';
      const text = await web!.read(url);
      const shown = text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n[…the rest of the page is cut off]` : text;
      const n = cite ? ` n="${cite({ title: url, url })}"` : '';
      return `<web_page${n} url="${attr(url)}">\n${shown}\n</web_page>`;
    },
  },
  {
    // Not run here: this entry is the company switch for the Chrome extension's
    // browser actions (src/browser-agent.ts). Off by default, like every write tool.
    name: 'browser_control',
    kind: 'write',
    needs: 'browser',
    description:
      "Lets the Chrome extension act on websites for this company's people: click, type, choose options and move between pages. It always asks the person before sending, submitting, buying or deleting. Without it, the extension can still read pages and answer questions about them.",
    parameters: { type: 'object', properties: {} },
    run: () => {
      throw new Error('Browser actions run in the Chrome extension.');
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

/** How much of a web page the agent is shown: enough to answer from, small enough for free-tier limits. */
const MAX_PAGE_CHARS = 8_000;

/** Makes text safe inside a double-quoted tag attribute. */
function attr(text: string): string {
  return text.replaceAll('"', "'").replaceAll('<', '‹').replaceAll('>', '›');
}

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): Tool | undefined {
  return BY_NAME.get(name);
}

/** Whether a company allows a tool: its admin's choice, else on for read tools and off for write tools. */
export function isToolAllowed(tool: Tool, settings: Map<string, boolean>): boolean {
  return settings.get(tool.name) ?? tool.kind === 'read';
}

/** Whether the caller can run the tool at all (web tools need a web search service; browser control, the extension). */
export function isToolAvailable(tool: Tool, services: { web?: WebSearcher; browser?: boolean }): boolean {
  if (tool.needs === 'web') return !!services.web;
  if (tool.needs === 'browser') return !!services.browser;
  return true;
}

/** Every tool with its current state for one company, for the admin page. */
export async function toolStates(store: Store, tenantId: string, services: { web?: WebSearcher; browser?: boolean } = {}) {
  const settings = await store.getToolSettings(tenantId);
  return TOOLS.map((t) => ({
    name: t.name,
    kind: t.kind,
    description: t.description,
    enabled: isToolAllowed(t, settings),
    available: isToolAvailable(t, services),
  }));
}
