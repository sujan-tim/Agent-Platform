/**
 * The company database: a Google Sheet tab of companies, one per row, with
 * its header in row 1, read and searched like a small database.
 *
 * Nothing about the columns is configured. They are read from the header, and
 * the data says the rest: a column whose values are nearly all numbers is a
 * number column (Volume, Net Sales…); a column that repeats a few values is a
 * list column (Status, Channel, Sales Rep…), whose existing values become the
 * allowed ones. The key column is "Company Name", or the first column.
 *
 * This file only reads, and writes changes a person has already approved
 * (see the sheet_changes table in the store). Before writing, it re-reads the
 * row to make sure it still holds the same company and the same old value, so
 * an approval never lands on a row someone has edited, moved or deleted since.
 */

import type { SheetBackend } from './google.ts';

export interface CompanyRow {
  /** The row number in the sheet (the header is row 1). */
  row: number;
  values: Record<string, string>;
}

export interface ColumnProfile {
  name: string;
  filled: number;
  numeric: boolean;
  /** The values in use, most common first, for a column that repeats a few values. */
  allowed?: string[];
  /** Columns your team fills (pipeline, sales figures): the agent never researches or guesses them. */
  internal: boolean;
}

export interface Condition {
  column: string;
  op: 'equals' | 'contains' | 'empty' | 'not_empty' | 'greater_than' | 'less_than';
  value?: string;
}

/** Columns that hold the company's own information, not public facts. Matched ignoring case. */
const INTERNAL_COLUMNS = ['status', 'channel', 'channel org', 'source', 'volume (mt)', 'net sales', 'sales rep'];
/** How long a read of the sheet is reused, to stay well inside Google's request limits. */
const CACHE_MS = 30_000;

export class CompanyDb {
  private cache?: { at: number; headers: string[]; rows: CompanyRow[] };

  constructor(
    private readonly backend: SheetBackend,
    readonly tab: string,
  ) {}

  async load(fresh = false): Promise<{ headers: string[]; rows: CompanyRow[] }> {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const grid = await this.backend.read(this.tab);
    const headers = (grid[0] ?? []).map((h) => h.trim());
    if (headers.filter(Boolean).length === 0) throw new Error(`The "${this.tab}" tab has no header row.`);
    const rows: CompanyRow[] = [];
    grid.slice(1).forEach((cells, i) => {
      if (!cells.some((c) => c?.trim())) return;
      const values: Record<string, string> = {};
      headers.forEach((h, k) => h && (values[h] = (cells[k] ?? '').trim()));
      rows.push({ row: i + 2, values });
    });
    this.cache = { at: Date.now(), headers: headers.filter(Boolean), rows };
    return this.cache;
  }

  /** Forget the cached read, after a write. */
  invalidate(): void {
    this.cache = undefined;
  }

  async keyColumn(): Promise<string> {
    const { headers } = await this.load();
    return headers.find((h) => /^company( name)?$/i.test(h)) ?? headers[0];
  }

  async profile(): Promise<ColumnProfile[]> {
    const { headers, rows } = await this.load();
    const key = await this.keyColumn();
    return headers.map((name) => {
      const values = rows.map((r) => r.values[name]).filter(Boolean);
      const numeric = values.length >= 3 && values.filter((v) => parseNumber(v) !== null).length / values.length >= 0.8;
      const counts = new Map<string, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      // A list column repeats a small set of values; a free-text column does not.
      const isList = name !== key && !numeric && values.length >= 4 && counts.size <= 25 && counts.size <= values.length / 2;
      return {
        name,
        filled: values.length,
        numeric,
        ...(isList && { allowed: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v) }),
        internal: INTERNAL_COLUMNS.includes(name.toLowerCase()),
      };
    });
  }

  async find(input: { where?: Condition[]; text?: string; limit?: number }): Promise<{ total: number; rows: CompanyRow[] }> {
    const { rows } = await this.load();
    const where = input.where ?? [];
    const text = input.text?.trim().toLowerCase();
    // Resolved once, so a misspelt column fails with the real column names.
    const columns = await Promise.all(where.map((c) => this.column(c.column)));
    const matches = rows.filter(
      (r) =>
        where.every((c, i) => matches_(r.values[columns[i]] ?? '', c)) &&
        (!text || Object.values(r.values).some((v) => v.toLowerCase().includes(text))),
    );
    return { total: matches.length, rows: matches.slice(0, Math.min(input.limit ?? 20, 50)) };
  }

  /**
   * Rows that are this company: every row with the same name once case,
   * punctuation and words like "Inc." are set aside (so "Acme Bakery" finds
   * both "ACME Bakery" and "Acme Bakery Inc.", and the caller must choose),
   * else rows whose name contains it.
   */
  async get(name: string): Promise<CompanyRow[]> {
    const { rows } = await this.load();
    const key = await this.keyColumn();
    const normal = normaliseName(name);
    if (!normal) return [];
    const same = rows.filter((r) => normaliseName(r.values[key] ?? '') === normal);
    if (same.length) return same;
    return rows.filter((r) => normaliseName(r.values[key] ?? '').includes(normal)).slice(0, 5);
  }

  /** Totals, averages or counts grouped by a column, e.g. Net Sales by Country. */
  async aggregate(input: { groupBy: string; measure?: string; op: 'sum' | 'average' | 'count' }): Promise<Array<{ group: string; value: number; rows: number }>> {
    const { rows } = await this.load();
    const groupBy = await this.column(input.groupBy);
    const measure = input.op === 'count' ? undefined : await this.column(input.measure ?? '');
    const groups = new Map<string, { sum: number; n: number; rows: number }>();
    for (const r of rows) {
      const group = r.values[groupBy] || '(empty)';
      const g = groups.get(group) ?? { sum: 0, n: 0, rows: 0 };
      g.rows++;
      if (measure) {
        const n = parseNumber(r.values[measure] ?? '');
        if (n !== null) {
          g.sum += n;
          g.n++;
        }
      }
      groups.set(group, g);
    }
    return [...groups.entries()]
      .map(([group, g]) => ({ group, rows: g.rows, value: input.op === 'count' ? g.rows : input.op === 'average' ? (g.n ? g.sum / g.n : 0) : g.sum }))
      .sort((a, b) => b.value - a.value);
  }

  /** Groups of rows that look like the same company: the same name once "Inc."/"Ltd." are set aside, or the same website. */
  async duplicates(): Promise<CompanyRow[][]> {
    const { rows, headers } = await this.load();
    const key = await this.keyColumn();
    const website = headers.find((h) => /website|url|domain/i.test(h));
    const groups = new Map<string, CompanyRow[]>();
    for (const r of rows) {
      const keys = new Set<string>();
      const name = normaliseName(r.values[key] ?? '');
      if (name) keys.add(`name:${name}`);
      const domain = website ? domainOf(r.values[website] ?? '') : '';
      if (domain) keys.add(`site:${domain}`);
      for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const seen = new Set<string>();
    const result: CompanyRow[][] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const id = group.map((r) => r.row).sort((a, b) => a - b).join(',');
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(group);
    }
    return result;
  }

  /**
   * Checks a proposed value for a column. Numbers must be numbers; a list
   * column's new value is allowed but flagged, since it may be a typo.
   */
  async check(column: string, value: string): Promise<{ column: string; error?: string; warning?: string }> {
    const name = await this.column(column);
    const profile = (await this.profile()).find((p) => p.name === name)!;
    const v = value.trim();
    if (v && profile.numeric && parseNumber(v) === null) return { column: name, error: `${name} takes a number; "${v}" is not one.` };
    if (v && profile.allowed && !profile.allowed.some((a) => a.toLowerCase() === v.toLowerCase())) {
      return { column: name, warning: `"${v}" is a new value for ${name} (in use: ${profile.allowed.slice(0, 8).join(', ')}).` };
    }
    return { column: name };
  }

  /** The sheet's column called `name`, ignoring case and extra spaces; throws with the real names if none. */
  async column(name: string): Promise<string> {
    const { headers } = await this.load();
    const found = resolveColumnSync(headers, name);
    if (!found) throw new Error(`There is no column "${name}". Columns: ${headers.join(', ')}.`);
    return found;
  }

  /**
   * Writes an approved cell change, after checking the row still holds the
   * same company and the same old value. Returns why not, if it cannot.
   */
  async applyUpdate(change: { row: number; company: string; column: string; oldValue: string; newValue: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { headers, rows } = await this.load(true);
    const key = await this.keyColumn();
    const row = rows.find((r) => r.row === change.row);
    if (!row || row.values[key] !== change.company) return { ok: false, reason: `Row ${change.row} no longer holds ${change.company}; the sheet changed. Propose it again.` };
    const column = resolveColumnSync(headers, change.column);
    if (!column) return { ok: false, reason: `The column ${change.column} is gone.` };
    if ((row.values[column] ?? '') !== change.oldValue) {
      return { ok: false, reason: `${column} for ${change.company} changed to "${row.values[column]}" since this was proposed.` };
    }
    await this.backend.write(this.tab, [{ row: change.row, column: headers.indexOf(column) + 1, value: change.newValue }]);
    this.invalidate();
    return { ok: true };
  }

  /** Adds an approved company as a new row, unless one with the same name or website has appeared since. */
  async applyAdd(values: Record<string, string>): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { headers } = await this.load(true);
    const key = await this.keyColumn();
    const existing = await this.get(values[key] ?? '');
    if (existing.some((r) => normaliseName(r.values[key] ?? '') === normaliseName(values[key] ?? ''))) {
      return { ok: false, reason: `${values[key]} is already in row ${existing[0].row}.` };
    }
    await this.backend.append(this.tab, headers.map((h) => values[h] ?? ''));
    this.invalidate();
    return { ok: true };
  }
}

function resolveColumnSync(headers: string[], name: string): string | undefined {
  const want = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return headers.find((h) => h.toLowerCase().replace(/\s+/g, ' ') === want) ?? headers.find((h) => h.toLowerCase().startsWith(want) && want.length >= 3);
}

function matches_(value: string, c: Condition): boolean {
  const v = value.trim();
  const target = (c.value ?? '').trim().toLowerCase();
  switch (c.op) {
    case 'empty':
      return v === '';
    case 'not_empty':
      return v !== '';
    case 'equals':
      return v.toLowerCase() === target;
    case 'contains':
      return v.toLowerCase().includes(target);
    case 'greater_than':
    case 'less_than': {
      const n = parseNumber(v);
      const t = parseNumber(c.value ?? '');
      if (n === null || t === null) return false;
      return c.op === 'greater_than' ? n > t : n < t;
    }
  }
}

/** "$1,250,000", "1.2M", "3 500", "45%" → numbers; anything else → null. */
export function parseNumber(text: string): number | null {
  const m = /^[^\d\-+.]*([-+]?[\d\s,]*\.?\d+)\s*([kmb])?\b[^\d]*$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1].replace(/[\s,]/g, ''));
  if (!Number.isFinite(n)) return null;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase() as 'k' | 'm' | 'b'] ?? 1;
  return n * scale;
}

const LEGAL_WORDS = new Set(
  'inc incorporated llc ltd limited corp corporation co company sa sas srl spa gmbh ag plc bv nv pvt private pte pty sa de cv ltda the group holdings'.split(' '),
);

/** A company name with case, punctuation and legal words like "Inc." or "S.A." removed, for matching. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    // "S.A." and "Co." become "sa" and "co" before punctuation is dropped.
    .replace(/\./g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_WORDS.has(w))
    .join(' ');
}

export function domainOf(url: string): string {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return '';
  try {
    return new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
