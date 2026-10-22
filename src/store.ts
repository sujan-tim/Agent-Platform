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

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
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
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  detail JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (tenant_id, conversation_id, id);
CREATE INDEX IF NOT EXISTS conversations_by_user ON conversations (tenant_id, user_id, seq);
CREATE INDEX IF NOT EXISTS documents_by_tenant ON documents (tenant_id);
CREATE INDEX IF NOT EXISTS chunks_by_document ON document_chunks (tenant_id, document_id, position);
CREATE INDEX IF NOT EXISTS audit_by_tenant ON audit_log (tenant_id, id);
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

  async addMessage(tenantId: string, conversationId: string, role: StoredMessage['role'], content: string): Promise<void> {
    await this.db.query(
      'INSERT INTO messages (tenant_id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)',
      [tenantId, conversationId, role, content, now()],
    );
  }

  /** The most recent `limit` messages, oldest first. */
  async getMessages(tenantId: string, conversationId: string, limit = 50): Promise<StoredMessage[]> {
    const rows = await this.db.query<{ role: StoredMessage['role']; content: string; created_at: string }>(
      'SELECT role, content, created_at FROM messages WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY id DESC LIMIT $3',
      [tenantId, conversationId, limit],
    );
    return rows.reverse().map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
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
   * Keyword search always runs: each passage scores by how many query words
   * it contains. Given the query's embedding, passages are also ranked by
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
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOP_WORDS.has(w));
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

    const byKeyword = chunks
      .map((c) => ({ id: c.id, score: words.filter((w) => c.text.toLowerCase().includes(w)).length }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score);
    addRanking(byKeyword.map((h) => h.id));

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
/** Passages longer than this are split, so each one is about one thing. */
const MAX_CHUNK_CHARS = 1000;

/**
 * Splits text into passages: paragraphs (separated by blank lines), with long
 * ones cut near MAX_CHUNK_CHARS at a sentence or line end where there is one.
 */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (const raw of text.split(/\n\s*\n/)) {
    let paragraph = raw.trim();
    while (paragraph.length > MAX_CHUNK_CHARS) {
      const window = paragraph.slice(0, MAX_CHUNK_CHARS);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf('? '), window.lastIndexOf('! '));
      const end = cut > MAX_CHUNK_CHARS / 2 ? cut + 1 : MAX_CHUNK_CHARS;
      chunks.push(paragraph.slice(0, end).trim());
      paragraph = paragraph.slice(end).trim();
    }
    if (paragraph) chunks.push(paragraph);
  }
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
