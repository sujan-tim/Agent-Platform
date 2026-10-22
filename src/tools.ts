/**
 * The tools the agent can use, and the gate that decides which it may use.
 *
 * Every tool declares its kind. `read` tools only look things up and are on by
 * default; `write` tools change something and are off until a company admin
 * turns them on. This mirrors Jarvis's read-only default, made per company.
 */

import type { ToolSpec } from './brain/types.ts';
import { type CompanyDb, type CompanyRow, type Condition, domainOf } from './companydb.ts';
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
  /** The company's connected Google Sheet, when it has one. */
  companies?: CompanyDb;
  /** Records a web page the answer may draw on and returns its number, for citing as [n]. */
  cite?: (page: { title: string; url: string }) => number;
}

export interface Tool extends ToolSpec {
  kind: 'read' | 'write';
  /**
   * Set when the tool needs something only some callers have: 'web' a web search
   * service, 'browser' the Chrome extension, which runs browser actions itself.
   */
  needs?: 'web' | 'browser' | 'sheet';
  /**
   * A write tool that only queues a proposal for a person to approve, so it is
   * safe to have on by default (and to offer the Chrome extension).
   */
  proposes?: boolean;
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
    name: 'company_db_overview',
    kind: 'read',
    needs: 'sheet',
    description:
      "Describes the company database (the connected Google Sheet): how many companies it holds, every column, how full each is, which columns are numbers, the values in use for list columns like Status or Sales Rep, and which columns are the team's own internal data. Use it first when unsure of the column names.",
    parameters: { type: 'object', properties: {} },
    run: async ({ companies }) => {
      const { rows } = await companies!.load();
      const profile = await companies!.profile();
      const lines = profile.map((p) => {
        const pct = rows.length ? Math.round((p.filled / rows.length) * 100) : 0;
        const kind = p.numeric ? 'number' : p.allowed ? `list: ${p.allowed.slice(0, 12).join(' | ')}${p.allowed.length > 12 ? ' | …' : ''}` : 'text';
        return `- ${p.name}: ${pct}% filled; ${kind}${p.internal ? '; INTERNAL (only from the team, never researched)' : ''}`;
      });
      return `The company database ("${companies!.tab}" tab) holds ${rows.length} companies.\nColumns:\n${lines.join('\n')}`;
    },
  },
  {
    name: 'find_companies',
    kind: 'read',
    needs: 'sheet',
    description:
      'Finds companies in the company database by conditions on columns and/or a word anywhere in the row. Returns the number found and up to 50 rows. Examples: country equals Brazil; Website empty; Net Sales greater_than 100000.',
    parameters: {
      type: 'object',
      properties: {
        where: {
          type: 'array',
          description: 'Conditions that must all hold.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'A column name, e.g. "Country".' },
              op: { type: 'string', enum: ['equals', 'contains', 'empty', 'not_empty', 'greater_than', 'less_than'] },
              value: { type: 'string', description: 'The value to compare with (not needed for empty and not_empty).' },
            },
            required: ['column', 'op'],
          },
        },
        text: { type: 'string', description: 'A word or phrase to find anywhere in the row.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Columns to show; all filled columns if left out.' },
        limit: { type: 'integer', description: 'How many rows to show, at most 50 (default 20).' },
      },
    },
    run: async ({ companies }, args) => {
      const where = Array.isArray(args.where) ? (args.where as Condition[]) : [];
      const { total, rows } = await companies!.find({
        where,
        text: typeof args.text === 'string' ? args.text : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
      if (total === 0) return 'No companies match.';
      const columns = Array.isArray(args.columns) ? await Promise.all((args.columns as string[]).map((c) => companies!.column(c))) : undefined;
      const key = await companies!.keyColumn();
      return `${total} compan${total === 1 ? 'y matches' : 'ies match'}${rows.length < total ? `; showing ${rows.length}` : ''}:\n${rows
        .map((r) => describeRow(r, key, columns))
        .join('\n')}`;
    },
  },
  {
    name: 'get_company',
    kind: 'read',
    needs: 'sheet',
    description: 'Shows every column of one company in the company database, found by name (ignoring "Inc.", "Ltd." and the like).',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The company name.' } },
      required: ['name'],
    },
    run: async ({ companies }, args) => {
      const found = await companies!.get(String(args.name ?? ''));
      if (found.length === 0) return `No company called "${args.name}" in the database.`;
      const key = await companies!.keyColumn();
      const { headers } = await companies!.load();
      return found
        .map((r) => [`Row ${r.row}: ${r.values[key]}`, ...headers.map((h) => `- ${h}: ${r.values[h] || '(empty)'}`)].join('\n'))
        .join('\n\n');
    },
  },
  {
    name: 'company_totals',
    kind: 'read',
    needs: 'sheet',
    description:
      'Adds up, averages or counts the company database by group, e.g. Net Sales by Country, Volume (MT) by Sales Rep, or how many companies per Status.',
    parameters: {
      type: 'object',
      properties: {
        group_by: { type: 'string', description: 'The column to group by, e.g. "Country".' },
        op: { type: 'string', enum: ['sum', 'average', 'count'] },
        measure: { type: 'string', description: 'The number column to add up or average (not needed for count).' },
      },
      required: ['group_by', 'op'],
    },
    run: async ({ companies }, args) => {
      const op = (['sum', 'average', 'count'].includes(String(args.op)) ? args.op : 'count') as 'sum' | 'average' | 'count';
      const result = await companies!.aggregate({ groupBy: String(args.group_by ?? ''), measure: String(args.measure ?? ''), op });
      const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
      const total = result.reduce((sum, g) => sum + g.value, 0);
      return [
        `${op === 'count' ? 'Companies' : `${op} of ${args.measure}`} by ${args.group_by}:`,
        ...result.map((g) => `- ${g.group}: ${fmt(g.value)}${op === 'count' ? '' : ` (${g.rows} companies)`}`),
        op === 'average' ? '' : `Total: ${fmt(total)}`,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'find_duplicate_companies',
    kind: 'read',
    needs: 'sheet',
    description: 'Lists rows in the company database that look like the same company: the same name once "Inc."/"Ltd." are set aside, or the same website.',
    parameters: { type: 'object', properties: {} },
    run: async ({ companies }) => {
      const groups = await companies!.duplicates();
      if (groups.length === 0) return 'No likely duplicates found.';
      const key = await companies!.keyColumn();
      return `${groups.length} group${groups.length === 1 ? '' : 's'} of likely duplicates:\n${groups
        .map((g) => `- ${g.map((r) => `row ${r.row} "${r.values[key]}"`).join(' / ')}`)
        .join('\n')}`;
    },
  },
  {
    name: 'propose_company_update',
    kind: 'write',
    proposes: true,
    needs: 'sheet',
    description:
      'Proposes changes to one company in the company database. Nothing changes yet: each change goes to the Review tab, where an admin approves it before it is written to the sheet. Internal columns (Status, Channel, Channel Org, Source, Volume, Net Sales, Sales Rep) only with a value the person gave you. For public facts found on the web, include the source links.',
    parameters: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'The company name as in the database.' },
        row: { type: 'integer', description: 'Its row number, when several rows share the name.' },
        changes: { type: 'object', description: 'Column name → new value, e.g. {"Website": "acme.com", "Country": "Brazil"}.' },
        reason: { type: 'string', description: 'Why, in a few words, e.g. "asked by Maria" or "found on the company website".' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Links to where public facts were found.' },
      },
      required: ['company', 'changes', 'reason'],
    },
    run: async ({ companies, store, tenantId, userId }, args) => {
      const db = companies!;
      const key = await db.keyColumn();
      let found = await db.get(String(args.company ?? ''));
      if (typeof args.row === 'number') found = found.filter((r) => r.row === args.row);
      if (found.length === 0) return `No company "${args.company}" in the database. Use propose_new_company to add it.`;
      if (found.length > 1) return `Several rows match: ${found.map((r) => `row ${r.row} "${r.values[key]}"`).join(', ')}. Say which with row.`;
      const target = found[0];
      const changes = args.changes && typeof args.changes === 'object' ? (args.changes as Record<string, unknown>) : {};
      const sources = cleanSources(args.sources);
      const profile = await db.profile();
      const lines: string[] = [];
      for (const [column, raw] of Object.entries(changes)) {
        const value = String(raw ?? '').trim();
        let checked;
        try {
          checked = await db.check(column, value);
        } catch (err) {
          lines.push(`✕ ${column}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        if (checked.error) {
          lines.push(`✕ ${checked.error}`);
          continue;
        }
        if (checked.column === key) {
          lines.push(`✕ ${key} is the company's name; rename it in the sheet itself.`);
          continue;
        }
        if (profile.find((p) => p.name === checked.column)?.internal && sources.length > 0) {
          lines.push(`✕ ${checked.column} is the team's internal data; it is never filled from the web. Ask the person for the value.`);
          continue;
        }
        const old = target.values[checked.column] ?? '';
        if (old === value) {
          lines.push(`= ${checked.column} is already "${value}".`);
          continue;
        }
        if (await store.findPendingChange(tenantId, target.values[key], checked.column, value)) {
          lines.push(`= ${checked.column} → "${value}" is already waiting for review.`);
          continue;
        }
        await store.proposeSheetChange(tenantId, userId, {
          kind: 'update',
          row: target.row,
          company: target.values[key],
          column: checked.column,
          oldValue: old,
          newValue: value,
          reason: String(args.reason ?? '').slice(0, 300),
          sources,
          warning: checked.warning ?? null,
        });
        lines.push(`✓ ${checked.column}: "${old || '(empty)'}" → "${value}"${checked.warning ? ` (note: ${checked.warning})` : ''}`);
      }
      return `Proposed for review (nothing in the sheet has changed yet; an admin approves in the Review tab):\n${lines.join('\n') || 'no changes given.'}`;
    },
  },
  {
    name: 'propose_new_company',
    kind: 'write',
    proposes: true,
    needs: 'sheet',
    description:
      'Proposes adding a new company to the company database. It first checks for an existing row with the same name or website. Nothing is added until an admin approves it in the Review tab.',
    parameters: {
      type: 'object',
      properties: {
        values: { type: 'object', description: 'Column name → value for the new row; must include the company name.' },
        reason: { type: 'string', description: 'Why, in a few words.' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Links to where public facts were found.' },
        not_a_duplicate: { type: 'boolean', description: 'True only after the person confirmed it is not the similar company already listed.' },
      },
      required: ['values', 'reason'],
    },
    run: async ({ companies, store, tenantId, userId }, args) => {
      const db = companies!;
      const key = await db.keyColumn();
      const given = args.values && typeof args.values === 'object' ? (args.values as Record<string, unknown>) : {};
      const values: Record<string, string> = {};
      const problems: string[] = [];
      const profile = await db.profile();
      const sources = cleanSources(args.sources);
      for (const [column, raw] of Object.entries(given)) {
        const value = String(raw ?? '').trim();
        if (!value) continue;
        try {
          const checked = await db.check(column, value);
          if (checked.error) problems.push(checked.error);
          else if (profile.find((p) => p.name === checked.column)?.internal && sources.length > 0 && checked.column !== key) {
            problems.push(`${checked.column} is the team's internal data; leave it out unless the person gave it.`);
          } else values[checked.column] = value;
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err));
        }
      }
      const name = values[key];
      if (!name) return `The new row needs a ${key}.`;
      if (problems.length) return `Not proposed. Fix these first:\n${problems.map((p) => `- ${p}`).join('\n')}`;
      if (!args.not_a_duplicate) {
        // The same name (ignoring "Inc." and the like), or the same website domain.
        const website = Object.keys(values).find((c) => /website|url|domain/i.test(c));
        const domain = website ? domainOf(values[website]) : '';
        const { rows } = await db.load();
        const clash = [
          ...(await db.get(name)),
          ...(domain ? rows.filter((r) => domainOf(r.values[website!] ?? '') === domain) : []),
        ];
        if (clash.length) {
          return `Possible duplicate: ${clash.slice(0, 3).map((r) => `row ${r.row} "${r.values[key]}"`).join(', ')}. Ask the person; if it is a different company, call again with not_a_duplicate true, otherwise use propose_company_update.`;
        }
      }
      if (await store.findPendingChange(tenantId, name, null, JSON.stringify(values))) return `Adding ${name} is already waiting for review.`;
      const warnings = (await Promise.all(Object.entries(values).map(([c, v]) => db.check(c, v)))).map((c) => c.warning).filter(Boolean);
      await store.proposeSheetChange(tenantId, userId, {
        kind: 'add',
        row: null,
        company: name,
        column: null,
        oldValue: null,
        newValue: JSON.stringify(values),
        reason: String(args.reason ?? '').slice(0, 300),
        sources,
        warning: warnings.join(' ') || null,
      });
      return `Proposed adding ${name} with ${Object.keys(values).length} filled columns. Nothing is added until an admin approves it in the Review tab.`;
    },
  },
  {
    name: 'remember_for_team',
    kind: 'write',
    proposes: true,
    description:
      "Saves a short fact or instruction to the team memory, which every teammate's agent keeps in mind, e.g. \"Maria now covers Mexico\" or \"Quote prices in USD\". Use it only when the person asks you to remember something for the team. An admin's memory is saved at once; anyone else's waits for an admin to approve it.",
    parameters: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'The fact or instruction, in one short sentence.' } },
      required: ['fact'],
    },
    run: async ({ store, tenantId, userId }, args) => {
      const fact = typeof args.fact === 'string' ? args.fact.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      if (!fact) return 'Nothing to remember: the fact was empty.';
      const known = [...(await store.listMemories(tenantId, 'active')), ...(await store.listMemories(tenantId, 'pending'))];
      if (known.some((m) => m.text.toLowerCase() === fact.toLowerCase())) return 'The team memory already has that.';
      const admin = (await store.getUser(tenantId, userId))?.role === 'admin';
      await store.addMemory(tenantId, userId, fact, admin ? 'active' : 'pending');
      await store.audit(tenantId, userId, 'memory_added', { fact, status: admin ? 'active' : 'pending' });
      return admin
        ? `Saved to the team memory: "${fact}". Every teammate's agent now keeps it in mind.`
        : `Sent for approval: "${fact}". It joins the team memory once an admin approves it in Approvals.`;
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

/** One database row as a line: its row number and its filled columns (or the chosen ones). */
function describeRow(r: CompanyRow, key: string, columns?: string[]): string {
  const shown = (columns ?? Object.keys(r.values)).filter((c) => c !== key && r.values[c]);
  const parts = shown.map((c) => `${c}: ${r.values[c].length > 120 ? `${r.values[c].slice(0, 119)}…` : r.values[c]}`);
  return `- Row ${r.row} · ${r.values[key] || '(no name)'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}

/** Only http(s) links, at most ten. */
function cleanSources(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((v) => String(v).trim())
    .filter((v) => /^https?:\/\/\S+$/i.test(v))
    .slice(0, 10);
}

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

/**
 * Whether a company allows a tool: its admin's choice, else on for read tools
 * and for write tools that only propose, and off for other write tools.
 */
export function isToolAllowed(tool: Tool, settings: Map<string, boolean>): boolean {
  return settings.get(tool.name) ?? (tool.kind === 'read' || !!tool.proposes);
}

/** Whether the caller can run the tool at all (web tools need a web search service; browser control, the extension). */
export function isToolAvailable(tool: Tool, services: { web?: WebSearcher; browser?: boolean; companies?: CompanyDb }): boolean {
  if (tool.needs === 'web') return !!services.web;
  if (tool.needs === 'browser') return !!services.browser;
  if (tool.needs === 'sheet') return !!services.companies;
  return true;
}

/** Every tool with its current state for one company, for the admin page. */
export async function toolStates(
  store: Store,
  tenantId: string,
  services: { web?: WebSearcher; browser?: boolean; companies?: CompanyDb } = {},
) {
  const settings = await store.getToolSettings(tenantId);
  return TOOLS.map((t) => ({
    name: t.name,
    kind: t.kind,
    description: t.description,
    enabled: isToolAllowed(t, settings),
    available: isToolAvailable(t, services),
    needs: t.needs ?? null,
  }));
}
