/**
 * All storage, kept per company.
 *
 * The rule this file exists to enforce: one company never sees another's data.
 * Every method that touches company data takes a `tenantId` and puts it in the
 * WHERE clause, so a route cannot forget it — there is no method that reads a
 * document, a conversation or an audit entry without one. test/store.test.ts
 * checks this.
 *
 * Runs on Postgres: a real server when hosted, PGlite (Postgres inside Node)
 * on a laptop and in the tests. See src/db.ts.
 */

import { randomUUID } from 'node:crypto';

import { type Db, openDb, type Queryable } from './db.ts';
import { cosine } from './embed.ts';
import { importSqlite } from './import-sqlite.ts';

export interface Tenant {
  id: string;
  name: string;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
}

/** A web page an answer drew on; answers cite it as [n]. */
export interface Source {
  n: number;
  title: string;
  url: string;
}

/** What is kept alongside an answer, so a reloaded conversation shows its sources. */
export interface MessageMeta {
  sources?: Source[];
  toolsUsed?: string[];
}

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  meta?: MessageMeta;
}

/** A company's connected Google Sheet. */
export interface SheetConnection {
  sheetId: string;
  tab: string;
}

/** A change to the company sheet, waiting for (or past) a person's decision. */
export interface SheetChange {
  id: number;
  kind: 'update' | 'add';
  status: 'pending' | 'applied' | 'rejected' | 'failed';
  row: number | null;
  company: string;
  column: string | null;
  oldValue: string | null;
  /** For an update, the new cell value; for an add, the new row as JSON. */
  newValue: string;
  reason: string;
  sources: string[];
  warning: string | null;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

/** Someone asking to join a company from the sign-in page; an admin approves or rejects it. */
export interface AccessRequest {
  id: number;
  name: string;
  email: string;
  note: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  /** The first question, shortened. */
  title: string;
  updatedAt: string;
}

export interface Document {
  id: string;
  title: string;
  text: string;
  createdAt: string;
}

export interface AuditEntry {
  at: string;
  userId: string | null;
  event: string;
  detail: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  seq INTEGER GENERATED ALWAYS AS IDENTITY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_chunks (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BYTEA,
  embedding_model TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_settings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  tool_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (tenant_id, tool_name)
);
CREATE TABLE IF NOT EXISTS sheet_connections (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  sheet_id TEXT NOT NULL UNIQUE,
  tab TEXT NOT NULL,
  connected_by TEXT NOT NULL,
  connected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sheet_changes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK (kind IN ('update', 'add')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'failed')),
  row_number INTEGER,
  company TEXT NOT NULL,
  column_name TEXT,
  old_value TEXT,
  new_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  sources JSONB NOT NULL,
  warning TEXT,
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  note TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  detail JSONB NOT NULL
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta JSONB;
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (tenant_id, conversation_id, id);
CREATE INDEX IF NOT EXISTS conversations_by_user ON conversations (tenant_id, user_id, seq);
CREATE INDEX IF NOT EXISTS documents_by_tenant ON documents (tenant_id);
CREATE INDEX IF NOT EXISTS chunks_by_document ON document_chunks (tenant_id, document_id, position);
CREATE INDEX IF NOT EXISTS audit_by_tenant ON audit_log (tenant_id, id);
CREATE INDEX IF NOT EXISTS access_requests_by_tenant ON access_requests (tenant_id, status, id);
CREATE INDEX IF NOT EXISTS sheet_changes_by_status ON sheet_changes (tenant_id, status, id);
`;

const now = () => new Date().toISOString();

export class Store {
  private constructor(private readonly db: Db) {}

  /**
   * Opens (and if needed creates) the database: a postgres:// URL, a folder
   * for PGlite, or `':memory:'` for a throwaway one (used by the tests).
   */
  static async open(location: string): Promise<Store> {
    const db = await openDb(location);
    await db.exec(SCHEMA);
    return new Store(db);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  /** Copies in the pre-Postgres SQLite database, if there is one and this database is empty. */
  importSqlite(path: string): Promise<Record<string, number> | null> {
    return importSqlite(this.db, path);
  }

  /** True if the database answers; for the health check. */
  async ping(): Promise<boolean> {
    await this.db.query('SELECT 1');
    return true;
  }

  // ── Companies and people ────────────────────────────────────────────────

  /** Creates a company and its first user, who is its admin. */
  async createTenantWithAdmin(input: { companyName: string; email: string; name: string; passwordHash: string }): Promise<{
    tenant: Tenant;
    user: User;
  }> {
    const tenant: Tenant = { id: randomUUID(), name: input.companyName };
    const user: User = {
      id: randomUUID(),
      tenantId: tenant.id,
      email: input.email.toLowerCase(),
      name: input.name,
      role: 'admin',
    };
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, $3)', [tenant.id, tenant.name, now()]);
      await insertUser(tx, user, input.passwordHash);
    });
    return { tenant, user };
  }

  /** Adds a person to an existing company. */
  async addUser(
    tenantId: string,
    input: { email: string; name: string; role: User['role']; passwordHash: string },
  ): Promise<User> {
    const user: User = { id: randomUUID(), tenantId, email: input.email.toLowerCase(), name: input.name, role: input.role };
    await insertUser(this.db, user, input.passwordHash);
    return user;
  }

  /** Sign-in lookup: the only read that is not scoped to a company, since the email is what finds it. */
  async findUserForLogin(email: string): Promise<(User & { passwordHash: string }) | undefined> {
    const [row] = await this.db.query<Record<string, string>>(
      'SELECT id, tenant_id, email, name, role, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    return row && { ...toUser(row), passwordHash: row.password_hash };
  }

  async getUser(tenantId: string, userId: string): Promise<User | undefined> {
    const [row] = await this.db.query<Record<string, string>>(
      'SELECT id, tenant_id, email, name, role FROM users WHERE tenant_id = $1 AND id = $2',
      [tenantId, userId],
    );
    return row && toUser(row);
  }

  async getTenant(tenantId: string): Promise<Tenant | undefined> {
    const [row] = await this.db.query<Tenant>('SELECT id, name FROM tenants WHERE id = $1', [tenantId]);
    return row && { id: row.id, name: row.name };
  }

  // ── Conversations ───────────────────────────────────────────────────────

  async createConversation(tenantId: string, userId: string): Promise<string> {
    const id = randomUUID();
    await this.db.query('INSERT INTO conversations (id, tenant_id, user_id, created_at) VALUES ($1, $2, $3, $4)', [
      id,
      tenantId,
      userId,
      now(),
    ]);
    return id;
  }

  /** True only if the conversation belongs to this person at this company. */
  async ownsConversation(tenantId: string, userId: string, conversationId: string): Promise<boolean> {
    const rows = await this.db.query('SELECT 1 FROM conversations WHERE tenant_id = $1 AND user_id = $2 AND id = $3', [
      tenantId,
      userId,
      conversationId,
    ]);
    return rows.length > 0;
  }

  async latestConversation(tenantId: string, userId: string): Promise<string | undefined> {
    const [row] = await this.db.query<{ id: string }>(
      'SELECT id FROM conversations WHERE tenant_id = $1 AND user_id = $2 ORDER BY seq DESC LIMIT 1',
      [tenantId, userId],
    );
    return row?.id;
  }

  async addMessage(
    tenantId: string,
    conversationId: string,
    role: StoredMessage['role'],
    content: string,
    meta?: MessageMeta,
  ): Promise<void> {
    await this.db.query(
      'INSERT INTO messages (tenant_id, conversation_id, role, content, created_at, meta) VALUES ($1, $2, $3, $4, $5, $6)',
      [tenantId, conversationId, role, content, now(), meta ? JSON.stringify(meta) : null],
    );
  }

  /** This person's conversations that have messages, most recently active first. */
  async listConversations(tenantId: string, userId: string, limit = 50): Promise<ConversationSummary[]> {
    const rows = await this.db.query<{ id: string; title: string | null; updated_at: string }>(
      `SELECT c.id,
              (SELECT m.content FROM messages m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS title,
              last.created_at AS updated_at
       FROM conversations c
       JOIN LATERAL (SELECT m.id, m.created_at FROM messages m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) last ON true
       WHERE c.tenant_id = $1 AND c.user_id = $2
       ORDER BY last.id DESC
       LIMIT $3`,
      [tenantId, userId, limit],
    );
    return rows.map((r) => ({ id: r.id, title: shorten(r.title ?? 'New chat', 60), updatedAt: r.updated_at }));
  }

  /** Deletes one of this person's conversations and its messages. False if it is not theirs. */
  async deleteConversation(tenantId: string, userId: string, conversationId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const owned = await tx.query('SELECT 1 FROM conversations WHERE tenant_id = $1 AND user_id = $2 AND id = $3', [
        tenantId,
        userId,
        conversationId,
      ]);
      if (owned.length === 0) return false;
      await tx.query('DELETE FROM messages WHERE tenant_id = $1 AND conversation_id = $2', [tenantId, conversationId]);
      await tx.query('DELETE FROM conversations WHERE tenant_id = $1 AND id = $2', [tenantId, conversationId]);
      return true;
    });
  }

  /** The most recent `limit` messages, oldest first. */
  async getMessages(tenantId: string, conversationId: string, limit = 50): Promise<StoredMessage[]> {
    const rows = await this.db.query<{ role: StoredMessage['role']; content: string; created_at: string; meta: MessageMeta | null }>(
      'SELECT role, content, created_at, meta FROM messages WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY id DESC LIMIT $3',
      [tenantId, conversationId, limit],
    );
    return rows
      .reverse()
      .map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at, ...(r.meta && { meta: r.meta }) }));
  }

  // ── Documents and notes ─────────────────────────────────────────────────

  /** Stores a document and splits it into passages for search, in one transaction. */
  async addDocument(tenantId: string, title: string, text: string): Promise<Document> {
    const doc: Document = { id: randomUUID(), title, text, createdAt: now() };
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO documents (id, tenant_id, title, text, created_at) VALUES ($1, $2, $3, $4, $5)', [
        doc.id,
        tenantId,
        doc.title,
        doc.text,
        doc.createdAt,
      ]);
      const chunks = chunkText(doc.text);
      if (chunks.length > 0) {
        // One statement for all passages: a long document has hundreds.
        await tx.query(
          `INSERT INTO document_chunks (tenant_id, document_id, position, text)
           SELECT $1, $2, ordinality - 1, chunk FROM unnest($3::text[]) WITH ORDINALITY AS t(chunk, ordinality)`,
          [tenantId, doc.id, chunks],
        );
      }
    });
    return doc;
  }

  async listDocuments(tenantId: string): Promise<Array<Omit<Document, 'text'> & { length: number }>> {
    const rows = await this.db.query<{ id: string; title: string; length: number; created_at: string }>(
      'SELECT id, title, length(text) AS length, created_at FROM documents WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, length: Number(r.length), createdAt: r.created_at }));
  }

  async deleteDocument(tenantId: string, documentId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM document_chunks WHERE tenant_id = $1 AND document_id = $2', [tenantId, documentId]);
      const deleted = await tx.query('DELETE FROM documents WHERE tenant_id = $1 AND id = $2 RETURNING id', [
        tenantId,
        documentId,
      ]);
      return deleted.length > 0;
    });
  }

  /** Passages of this company with no vector from `model` yet. */
  async chunksToEmbed(tenantId: string, model: string, limit: number): Promise<Array<{ id: number; title: string; text: string }>> {
    return this.db.query(
      `SELECT c.id, d.title, c.text FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.tenant_id = $1 AND (c.embedding_model IS NULL OR c.embedding_model != $2)
       ORDER BY c.id LIMIT $3`,
      [tenantId, model, limit],
    );
  }

  async setChunkEmbedding(tenantId: string, chunkId: number, model: string, vector: Float32Array): Promise<void> {
    await this.db.query('UPDATE document_chunks SET embedding = $1, embedding_model = $2 WHERE tenant_id = $3 AND id = $4', [
      new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
      model,
      tenantId,
      chunkId,
    ]);
  }

  /** How many of this company's passages can be searched by meaning with `model`. */
  async embeddingCoverage(tenantId: string, model: string): Promise<{ embedded: number; total: number }> {
    const [row] = await this.db.query<{ total: number; embedded: number }>(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE embedding_model = $1))::int AS embedded
       FROM document_chunks WHERE tenant_id = $2`,
      [model, tenantId],
    );
    return { embedded: row.embedded, total: row.total };
  }

  /** Every company id, for start-up jobs that then work one company at a time. */
  async tenantIds(): Promise<string[]> {
    return (await this.db.query<{ id: string }>('SELECT id FROM tenants')).map((r) => r.id);
  }

  /**
   * Searches the company's documents, one passage at a time.
   *
   * Keyword search always runs, scored with BM25 (the usual search-engine
   * formula): a word found in few passages counts for more than one found in
   * most, repeats help with diminishing returns, and long passages are not
   * favoured just for being long. Words are compared after trimming common
   * endings, so "sales" finds "sale". Given the query's embedding, passages are also ranked by
   * closeness of meaning, and the two rankings are merged (reciprocal rank
   * fusion), so an exact term and a paraphrase both find their passage.
   * Without one — embeddings off, or the embedder failed — it is keyword
   * search alone.
   */
  async searchDocuments(
    tenantId: string,
    query: string,
    limit = 3,
    meaning?: { model: string; vector: Float32Array },
  ): Promise<Array<{ title: string; excerpt: string; score: number }>> {
    const words = [...new Set(terms(query))];
    if (words.length === 0 && !meaning) return [];
    const chunks = await this.db.query<{ id: number; title: string; text: string; embedding: Uint8Array | null }>(
      `SELECT c.id, d.title, c.text, CASE WHEN c.embedding_model = $1 THEN c.embedding END AS embedding
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.tenant_id = $2 ORDER BY c.id`,
      [meaning?.model ?? null, tenantId],
    );

    const fused = new Map<number, number>();
    const addRanking = (ranked: number[]) =>
      ranked.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));

    addRanking(rankByKeywords(chunks, words));

    if (meaning) {
      const byMeaning = chunks
        .filter((c) => c.embedding)
        .map((c) => ({ id: c.id, score: cosine(meaning.vector, toVector(c.embedding!)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MEANING_CANDIDATES);
      addRanking(byMeaning.map((h) => h.id));
    }

    const byId = new Map(chunks.map((c) => [c.id, c]));
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => ({ title: byId.get(id)!.title, excerpt: byId.get(id)!.text, score }));
  }

  async addNote(tenantId: string, userId: string, text: string): Promise<void> {
    await this.db.query('INSERT INTO notes (tenant_id, user_id, text, created_at) VALUES ($1, $2, $3, $4)', [
      tenantId,
      userId,
      text,
      now(),
    ]);
  }

  async listNotes(tenantId: string, userId: string): Promise<Array<{ text: string; createdAt: string }>> {
    const rows = await this.db.query<{ text: string; created_at: string }>(
      'SELECT text, created_at FROM notes WHERE tenant_id = $1 AND user_id = $2 ORDER BY id DESC',
      [tenantId, userId],
    );
    return rows.map((r) => ({ text: r.text, createdAt: r.created_at }));
  }

  // ── Access requests ─────────────────────────────────────────────────────

  /** The company that receives access requests from the sign-in page, if one does. */
  async accessRequestsTenant(): Promise<string | undefined> {
    const [row] = await this.db.query<{ value: string }>("SELECT value FROM server_settings WHERE key = 'access_requests_tenant'");
    return row?.value;
  }

  /**
   * Turns access requests on for a company (if no other company already
   * receives them) or off. Returns false if another company has them.
   */
  async setAccessRequestsTenant(tenantId: string, enabled: boolean): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query<{ value: string }>("SELECT value FROM server_settings WHERE key = 'access_requests_tenant' FOR UPDATE");
      if (row && row.value !== tenantId) return false;
      if (enabled && !row) {
        await tx.query("INSERT INTO server_settings (key, value) VALUES ('access_requests_tenant', $1)", [tenantId]);
      } else if (!enabled && row) {
        await tx.query("DELETE FROM server_settings WHERE key = 'access_requests_tenant'");
      }
      return true;
    });
  }

  /** Records a request, replacing an earlier pending one from the same email. */
  async createAccessRequest(tenantId: string, input: { name: string; email: string; passwordHash: string; note: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query("DELETE FROM access_requests WHERE tenant_id = $1 AND email = $2 AND status = 'pending'", [tenantId, input.email.toLowerCase()]);
      await tx.query(
        `INSERT INTO access_requests (tenant_id, name, email, password_hash, note, status, created_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [tenantId, input.name, input.email.toLowerCase(), input.passwordHash, input.note, now()],
      );
    });
  }

  /** A pending request for this email, with its password hash, so sign-in can say it is waiting. */
  async pendingAccessRequest(email: string): Promise<{ passwordHash: string } | undefined> {
    const [row] = await this.db.query<{ password_hash: string }>(
      "SELECT password_hash FROM access_requests WHERE email = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1",
      [email.toLowerCase()],
    );
    return row && { passwordHash: row.password_hash };
  }

  async listAccessRequests(tenantId: string, status: AccessRequest['status'] = 'pending'): Promise<AccessRequest[]> {
    const rows = await this.db.query<Record<string, any>>(
      'SELECT id, name, email, note, status, created_at FROM access_requests WHERE tenant_id = $1 AND status = $2 ORDER BY id DESC LIMIT 200',
      [tenantId, status],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, note: r.note, status: r.status, createdAt: r.created_at }));
  }

  /** Marks a pending request decided and returns it with its password hash; undefined if it is not pending here. */
  async decideAccessRequest(
    tenantId: string,
    id: number,
    userId: string,
    status: 'approved' | 'rejected',
  ): Promise<(AccessRequest & { passwordHash: string }) | undefined> {
    const [row] = await this.db.query<Record<string, any>>(
      `UPDATE access_requests SET status = $1, decided_by = $2, decided_at = $3
       WHERE tenant_id = $4 AND id = $5 AND status = 'pending'
       RETURNING id, name, email, note, status, created_at, password_hash`,
      [status, userId, now(), tenantId, id],
    );
    return row && { id: row.id, name: row.name, email: row.email, note: row.note, status: row.status, createdAt: row.created_at, passwordHash: row.password_hash };
  }

  // ── The company sheet ───────────────────────────────────────────────────

  async getSheetConnection(tenantId: string): Promise<SheetConnection | undefined> {
    const [row] = await this.db.query<{ sheet_id: string; tab: string }>('SELECT sheet_id, tab FROM sheet_connections WHERE tenant_id = $1', [tenantId]);
    return row && { sheetId: row.sheet_id, tab: row.tab };
  }

  /** Which company, if any, has connected this sheet. A sheet belongs to one company. */
  async sheetOwner(sheetId: string): Promise<string | undefined> {
    const [row] = await this.db.query<{ tenant_id: string }>('SELECT tenant_id FROM sheet_connections WHERE sheet_id = $1', [sheetId]);
    return row?.tenant_id;
  }

  async connectSheet(tenantId: string, userId: string, sheet: SheetConnection): Promise<void> {
    await this.db.query(
      `INSERT INTO sheet_connections (tenant_id, sheet_id, tab, connected_by, connected_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE SET sheet_id = excluded.sheet_id, tab = excluded.tab, connected_by = excluded.connected_by, connected_at = excluded.connected_at`,
      [tenantId, sheet.sheetId, sheet.tab, userId, now()],
    );
  }

  async disconnectSheet(tenantId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query("UPDATE sheet_changes SET status = 'rejected', note = 'sheet disconnected' WHERE tenant_id = $1 AND status = 'pending'", [tenantId]);
      await tx.query('DELETE FROM sheet_connections WHERE tenant_id = $1', [tenantId]);
    });
  }

  async proposeSheetChange(
    tenantId: string,
    userId: string,
    change: Pick<SheetChange, 'kind' | 'row' | 'company' | 'column' | 'oldValue' | 'newValue' | 'reason' | 'sources' | 'warning'>,
  ): Promise<number> {
    const [row] = await this.db.query<{ id: number }>(
      `INSERT INTO sheet_changes (tenant_id, kind, status, row_number, company, column_name, old_value, new_value, reason, sources, warning, proposed_by, proposed_at)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        tenantId,
        change.kind,
        change.row,
        change.company,
        change.column,
        change.oldValue,
        change.newValue,
        change.reason,
        JSON.stringify(change.sources),
        change.warning,
        userId,
        now(),
      ],
    );
    return row.id;
  }

  /** A pending change to the same cell, so the same proposal is not queued twice. */
  async findPendingChange(tenantId: string, company: string, column: string | null, newValue: string): Promise<number | undefined> {
    const [row] = await this.db.query<{ id: number }>(
      `SELECT id FROM sheet_changes WHERE tenant_id = $1 AND status = 'pending' AND company = $2
       AND column_name IS NOT DISTINCT FROM $3 AND new_value = $4 LIMIT 1`,
      [tenantId, company, column, newValue],
    );
    return row?.id;
  }

  async listSheetChanges(tenantId: string, status: SheetChange['status'] | 'all' = 'pending', limit = 200): Promise<SheetChange[]> {
    const rows = await this.db.query<Record<string, any>>(
      `SELECT c.*, p.name AS proposer, d.name AS decider FROM sheet_changes c
       LEFT JOIN users p ON p.id = c.proposed_by AND p.tenant_id = c.tenant_id
       LEFT JOIN users d ON d.id = c.decided_by AND d.tenant_id = c.tenant_id
       WHERE c.tenant_id = $1 AND ($2 = 'all' OR c.status = $2)
       ORDER BY c.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT $3`,
      [tenantId, status, limit],
    );
    return rows.map(toSheetChange);
  }

  async getSheetChanges(tenantId: string, ids: number[]): Promise<SheetChange[]> {
    const rows = await this.db.query<Record<string, any>>(
      `SELECT c.*, p.name AS proposer, NULL AS decider FROM sheet_changes c
       LEFT JOIN users p ON p.id = c.proposed_by AND p.tenant_id = c.tenant_id
       WHERE c.tenant_id = $1 AND c.id = ANY($2::int[]) ORDER BY c.id`,
      [tenantId, ids],
    );
    return rows.map(toSheetChange);
  }

  async decideSheetChange(tenantId: string, id: number, userId: string, status: 'applied' | 'rejected' | 'failed', note?: string): Promise<void> {
    await this.db.query(
      "UPDATE sheet_changes SET status = $1, decided_by = $2, decided_at = $3, note = $4 WHERE tenant_id = $5 AND id = $6 AND status = 'pending'",
      [status, userId, now(), note ?? null, tenantId, id],
    );
  }

  // ── Tool rules ──────────────────────────────────────────────────────────

  /** Explicit admin choices for this company; tools not listed use their default. */
  async getToolSettings(tenantId: string): Promise<Map<string, boolean>> {
    const rows = await this.db.query<{ tool_name: string; enabled: boolean }>(
      'SELECT tool_name, enabled FROM tool_settings WHERE tenant_id = $1',
      [tenantId],
    );
    return new Map(rows.map((r) => [r.tool_name, r.enabled]));
  }

  async setToolEnabled(tenantId: string, toolName: string, enabled: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO tool_settings (tenant_id, tool_name, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, tool_name) DO UPDATE SET enabled = excluded.enabled`,
      [tenantId, toolName, enabled],
    );
  }

  // ── Audit log ───────────────────────────────────────────────────────────

  async audit(tenantId: string, userId: string | null, event: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.db.query('INSERT INTO audit_log (tenant_id, user_id, at, event, detail) VALUES ($1, $2, $3, $4, $5)', [
      tenantId,
      userId,
      now(),
      event,
      JSON.stringify(detail),
    ]);
  }

  /** Newest first. */
  async getAudit(tenantId: string, limit = 100): Promise<AuditEntry[]> {
    const rows = await this.db.query<{ at: string; user_id: string | null; event: string; detail: Record<string, unknown> }>(
      'SELECT at, user_id, event, detail FROM audit_log WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2',
      [tenantId, limit],
    );
    return rows.map((r) => ({ at: r.at, userId: r.user_id, event: r.event, detail: r.detail }));
  }
}

function toSheetChange(r: Record<string, any>): SheetChange {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    row: r.row_number,
    company: r.company,
    column: r.column_name,
    oldValue: r.old_value,
    newValue: r.new_value,
    reason: r.reason,
    sources: r.sources ?? [],
    warning: r.warning,
    proposedBy: r.proposer ?? 'someone',
    proposedAt: r.proposed_at,
    decidedBy: r.decider ?? null,
    decidedAt: r.decided_at,
    note: r.note,
  };
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function insertUser(db: Queryable, user: User, passwordHash: string) {
  return db.query(
    'INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [user.id, user.tenantId, user.email, user.name, user.role, passwordHash, now()],
  );
}

/** Standard constant for reciprocal rank fusion; it damps the gap between the first few ranks. */
const RRF_K = 60;
/** How many passages the meaning ranking contributes; the rest are too far off to help. */
const MEANING_CANDIDATES = 20;
/** Common English words that match almost any passage, so keyword search ignores them. */
const STOP_WORDS = new Set(
  (
    'the and for are but not you your all any can had has have her his how its our out was were what when where ' +
    'which who why will with get got does did this that there their them they then than from into about would ' +
    'could should may might must also just more most some such very many much been being here tell know'
  ).split(' '),
);
/** BM25's usual settings: how fast repeats stop helping, and how much length is discounted. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** How much a query word in the document's title adds, relative to one in the passage. */
const TITLE_WEIGHT = 0.5;

/** Passage ids that contain any query word, best match first (BM25). */
function rankByKeywords(chunks: Array<{ id: number; title: string; text: string }>, words: string[]): number[] {
  if (words.length === 0) return [];
  const counted = chunks.map((c) => {
    const counts = new Map<string, number>();
    const list = terms(c.text);
    for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
    return { id: c.id, counts, length: list.length, title: new Set(terms(c.title)) };
  });
  const averageLength = counted.reduce((sum, c) => sum + c.length, 0) / Math.max(1, counted.length);
  const idf = new Map(
    words.map((w) => {
      const df = counted.filter((c) => c.counts.has(w)).length;
      return [w, Math.log(1 + (counted.length - df + 0.5) / (df + 0.5))];
    }),
  );
  return counted
    .map((c) => {
      let score = 0;
      for (const w of words) {
        const tf = c.counts.get(w) ?? 0;
        if (tf > 0) score += idf.get(w)! * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * c.length) / averageLength)));
      }
      // The document's title adds a little, but only to a passage that matches on its own,
      // so "leadership" favours the leadership document without lifting its list of links.
      if (score > 0) for (const w of words) if (c.title.has(w)) score += TITLE_WEIGHT * idf.get(w)!;
      return { id: c.id, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((h) => h.id);
}

/** Searchable words of a text: lower case, no links, no stop words, common endings trimmed. */
function terms(text: string): string[] {
  const words = text.replace(/https?:\/\/\S+/g, ' ').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return words.filter((w) => !STOP_WORDS.has(w)).map(stem);
}

/** Trims a plural or verb ending, so "sales", "selling" and "headquartered" meet their root forms. */
function stem(word: string): string {
  for (const ending of ['ing', 'ed', 'es', 's']) {
    if (word.endsWith(ending) && word.length - ending.length >= 4) return word.slice(0, -ending.length);
  }
  return word;
}

/** Passages longer than this are split, so each one is about one thing. */
const MAX_CHUNK_CHARS = 1000;

/**
 * Splits text into passages: paragraphs (separated by blank lines), with long
 * ones cut near MAX_CHUNK_CHARS at a sentence or line end where there is one.
 */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let heading = '';
  for (const raw of text.split(/\n\s*\n/)) {
    let paragraph = raw.trim();
    // A heading on its own says little; it travels with the paragraph below it.
    if (/^#{1,6}\s/.test(paragraph) && !paragraph.includes('\n')) {
      heading = heading ? `${heading}\n${paragraph}` : paragraph;
      continue;
    }
    if (heading && paragraph) {
      paragraph = `${heading}\n${paragraph}`;
      heading = '';
    }
    while (paragraph.length > MAX_CHUNK_CHARS) {
      const window = paragraph.slice(0, MAX_CHUNK_CHARS);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf('? '), window.lastIndexOf('! '));
      const end = cut > MAX_CHUNK_CHARS / 2 ? cut + 1 : MAX_CHUNK_CHARS;
      chunks.push(paragraph.slice(0, end).trim());
      paragraph = paragraph.slice(end).trim();
    }
    if (paragraph) chunks.push(paragraph);
  }
  if (heading) chunks.push(heading);
  return chunks;
}

function toVector(blob: Uint8Array): Float32Array {
  // Copied so the floats are aligned whatever the blob's offset.
  return new Float32Array(Uint8Array.from(blob).buffer);
}

function toUser(row: Record<string, string>): User {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    role: row.role as User['role'],
  };
}
