/**
 * Google sign-in for the server's robot account (a Google Cloud service
 * account), and a small Google Sheets client on top of it.
 *
 * The service account's key file goes in GOOGLE_SERVICE_ACCOUNT_JSON, whole.
 * The server signs a short JWT with the key and trades it at Google for an
 * access token, as Google documents for server-to-server use
 * (https://developers.google.com/identity/protocols/oauth2/service-account).
 * The robot only reaches sheets that someone has shared with its email.
 */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TIMEOUT_MS = 30_000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Reads the key file from the environment; undefined when it is not set. Throws if it is set but unusable. */
export function serviceAccountFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceAccount | undefined {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return undefined;
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file, from { to }.');
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON needs client_email and private_key. Paste the whole key file.');
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri };
}

/** Access tokens for one service account, renewed shortly before they expire. */
export class GoogleAuth {
  private token = '';
  private expiresAt = 0;

  constructor(
    private readonly account: ServiceAccount,
    private readonly scope = SHEETS_SCOPE,
  ) {}

  get email(): string {
    return this.account.client_email;
  }

  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: this.account.client_email,
      scope: this.scope,
      aud: this.account.token_uri ?? TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key).toString('base64url');
    const res = await fetch(this.account.token_uri ?? TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`Google refused the robot account's sign-in: ${body.error_description ?? res.status}. Check GOOGLE_SERVICE_ACCOUNT_JSON.`);
    }
    this.token = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.token;
  }
}

/** What the company database needs from a spreadsheet tab. Tests use an in-memory one. */
export interface SheetBackend {
  /** The spreadsheet's tabs. */
  tabs(): Promise<string[]>;
  /** Every row of a tab, as text, the header row first. */
  read(tab: string): Promise<string[][]>;
  /** Sets single cells; `row` and `column` count from 1, as in the sheet. */
  write(tab: string, cells: Array<{ row: number; column: number; value: string }>): Promise<void>;
  /** Adds a row after the last one. */
  append(tab: string, values: string[]): Promise<void>;
}

export class GoogleSheet implements SheetBackend {
  constructor(
    private readonly auth: GoogleAuth,
    readonly spreadsheetId: string,
    /** Google's Sheets API; tests point it at a stand-in. */
    private readonly api = SHEETS_API,
  ) {}

  async tabs(): Promise<string[]> {
    const body = await this.call<{ sheets?: Array<{ properties: { title: string } }> }>('GET', '?fields=sheets.properties.title');
    return (body.sheets ?? []).map((s) => s.properties.title);
  }

  async read(tab: string): Promise<string[][]> {
    const body = await this.call<{ values?: string[][] }>('GET', `/values/${encodeURIComponent(quoteTab(tab))}?valueRenderOption=FORMATTED_VALUE`);
    return body.values ?? [];
  }

  async write(tab: string, cells: Array<{ row: number; column: number; value: string }>): Promise<void> {
    if (cells.length === 0) return;
    await this.call('POST', '/values:batchUpdate', {
      // As if typed by a person: numbers become numbers and dates become dates.
      valueInputOption: 'USER_ENTERED',
      data: cells.map((c) => ({ range: `${quoteTab(tab)}!${columnLetter(c.column)}${c.row}`, values: [[c.value]] })),
    });
  }

  async append(tab: string, values: string[]): Promise<void> {
    await this.call(
      'POST',
      `/values/${encodeURIComponent(`${quoteTab(tab)}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { values: [values] },
    );
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.api}/${encodeURIComponent(this.spreadsheetId)}${path}`, {
        method,
        headers: { authorization: `Bearer ${await this.auth.accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Google refused')) throw err;
      throw new Error('Could not reach Google Sheets.');
    }
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `Google Sheets says the robot account cannot open this spreadsheet. Share it with ${this.auth.email} as Editor, and check the sheet ID.`,
      );
    }
    if (res.status === 429) throw new Error('Google Sheets is rate-limiting requests; try again in a minute.');
    if (!res.ok) throw new Error(`Google Sheets returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

/** A tab name as Sheets ranges want it: quoted, with quotes doubled. */
function quoteTab(tab: string): string {
  return `'${tab.replaceAll("'", "''")}'`;
}

/** 1 → A, 27 → AA. */
export function columnLetter(column: number): string {
  let n = column;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}
