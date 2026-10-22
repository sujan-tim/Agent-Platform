/**
 * Which company database each company has: the link between a company on the
 * platform and its Google Sheet.
 *
 * The server's robot account can open every sheet shared with it, so a
 * company may only connect a sheet that is (a) on the server's list
 * (SHEET_ID, comma-separated for several) and (b) not already connected by
 * another company. A company's admin connects it by pasting its ID, which
 * also proves they know which sheet it is.
 */

import { CompanyDb } from './companydb.ts';
import { GoogleAuth, GoogleSheet, type SheetBackend, serviceAccountFromEnv } from './google.ts';
import type { Store } from './store.ts';

export class SheetService {
  private readonly dbs = new Map<string, CompanyDb>();

  constructor(
    private readonly store: Store,
    /** Sheets this server may connect. */
    private readonly allowed: Set<string>,
    private readonly backendFor: (sheetId: string) => SheetBackend,
    /** The robot account's email, shown to admins so they know whom to share with. */
    readonly robotEmail: string,
  ) {}

  isAllowed(sheetId: string): boolean {
    return this.allowed.has(sheetId);
  }

  /** The company's database, or undefined when it has not connected a sheet. */
  async forTenant(tenantId: string): Promise<CompanyDb | undefined> {
    const connection = await this.store.getSheetConnection(tenantId);
    if (!connection || !this.isAllowed(connection.sheetId)) return undefined;
    const key = `${tenantId}:${connection.sheetId}:${connection.tab}`;
    let db = this.dbs.get(key);
    if (!db) {
      db = new CompanyDb(this.backendFor(connection.sheetId), connection.tab);
      this.dbs.set(key, db);
    }
    return db;
  }

  /** The sheet's tabs, which also proves the robot can open it. */
  tabs(sheetId: string): Promise<string[]> {
    return this.backendFor(sheetId).tabs();
  }

  /** The tab most likely to hold the companies: one whose header has "Company", else the first. */
  async guessTab(sheetId: string, tabs: string[]): Promise<string> {
    const backend = this.backendFor(sheetId);
    for (const tab of tabs) {
      const [header] = await backend.read(tab);
      if (header?.some((h) => /^company( name)?$/i.test(h.trim()))) return tab;
    }
    return tabs[0];
  }

  forget(tenantId: string): void {
    for (const key of this.dbs.keys()) if (key.startsWith(`${tenantId}:`)) this.dbs.delete(key);
  }
}

/** Set up from GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID; undefined when either is missing. */
export function createSheetService(store: Store, env: NodeJS.ProcessEnv = process.env): SheetService | undefined {
  const account = serviceAccountFromEnv(env);
  const ids = (env.SHEET_ID ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (!account || ids.length === 0) return undefined;
  const auth = new GoogleAuth(account);
  return new SheetService(store, new Set(ids), (id) => new GoogleSheet(auth, id), account.client_email);
}
