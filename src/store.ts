/**
 * All storage, kept per company.
 *
 * The rule this file exists to enforce: one company never sees another's data.
 * Every method that touches company data takes a `tenantId` and puts it in the
 * WHERE clause, so a route cannot forget it — there is no method that reads a
 * document, a conversation or an audit entry without one. test/store.test.ts
 * checks this.
 *
 * Uses Node's built-in SQLite (node:sqlite), so there is no database server to
 * run. Moving to Postgres later means reimplementing this one class.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

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
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_settings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  tool_name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, tool_name)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (tenant_id, conversation_id, id);
CREATE INDEX IF NOT EXISTS documents_by_tenant ON documents (tenant_id);
CREATE INDEX IF NOT EXISTS audit_by_tenant ON audit_log (tenant_id, id);
`;

const now = () => new Date().toISOString();

export class Store {
  private readonly db: DatabaseSync;

  /** `':memory:'` gives a throwaway database (used by the tests). */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── Companies and people ────────────────────────────────────────────────

  /** Creates a company and its first user, who is its admin. */
  createTenantWithAdmin(input: { companyName: string; email: string; name: string; passwordHash: string }): {
    tenant: Tenant;
    user: User;
  } {
    const tenant: Tenant = { id: randomUUID(), name: input.companyName };
    const user: User = {
      id: randomUUID(),
      tenantId: tenant.id,
      email: input.email.toLowerCase(),
      name: input.name,
      role: 'admin',
    };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').run(tenant.id, tenant.name, now());
      this.insertUser(user, input.passwordHash);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { tenant, user };
  }

  /** Adds a person to an existing company. */
  addUser(
    tenantId: string,
    input: { email: string; name: string; role: User['role']; passwordHash: string },
  ): User {
    const user: User = { id: randomUUID(), tenantId, email: input.email.toLowerCase(), name: input.name, role: input.role };
    this.insertUser(user, input.passwordHash);
    return user;
  }

  private insertUser(user: User, passwordHash: string): void {
    this.db
      .prepare(
        'INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(user.id, user.tenantId, user.email, user.name, user.role, passwordHash, now());
  }

  /** Sign-in lookup: the only read that is not scoped to a company, since the email is what finds it. */
  findUserForLogin(email: string): (User & { passwordHash: string }) | undefined {
    const row = this.db
      .prepare('SELECT id, tenant_id, email, name, role, password_hash FROM users WHERE email = ?')
      .get(email.toLowerCase()) as Record<string, string> | undefined;
    return row && { ...toUser(row), passwordHash: row.password_hash };
  }

  getUser(tenantId: string, userId: string): User | undefined {
    const row = this.db
      .prepare('SELECT id, tenant_id, email, name, role FROM users WHERE tenant_id = ? AND id = ?')
      .get(tenantId, userId) as Record<string, string> | undefined;
    return row && toUser(row);
  }

  getTenant(tenantId: string): Tenant | undefined {
    const row = this.db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(tenantId) as
      | { id: string; name: string }
      | undefined;
    return row && { id: row.id, name: row.name };
  }

  // ── Conversations ───────────────────────────────────────────────────────

  createConversation(tenantId: string, userId: string): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO conversations (id, tenant_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(id, tenantId, userId, now());
    return id;
  }

  /** True only if the conversation belongs to this person at this company. */
  ownsConversation(tenantId: string, userId: string, conversationId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM conversations WHERE tenant_id = ? AND user_id = ? AND id = ?')
      .get(tenantId, userId, conversationId);
  }

  latestConversation(tenantId: string, userId: string): string | undefined {
    const row = this.db
      .prepare('SELECT id FROM conversations WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(tenantId, userId) as { id: string } | undefined;
    return row?.id;
  }

  addMessage(tenantId: string, conversationId: string, role: StoredMessage['role'], content: string): void {
    this.db
      .prepare('INSERT INTO messages (tenant_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(tenantId, conversationId, role, content, now());
  }

  /** The most recent `limit` messages, oldest first. */
  getMessages(tenantId: string, conversationId: string, limit = 50): StoredMessage[] {
    const rows = this.db
      .prepare(
        'SELECT role, content, created_at FROM messages WHERE tenant_id = ? AND conversation_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(tenantId, conversationId, limit) as Array<{ role: StoredMessage['role']; content: string; created_at: string }>;
    return rows.reverse().map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
  }

  // ── Documents and notes ─────────────────────────────────────────────────

  addDocument(tenantId: string, title: string, text: string): Document {
    const doc: Document = { id: randomUUID(), title, text, createdAt: now() };
    this.db
      .prepare('INSERT INTO documents (id, tenant_id, title, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(doc.id, tenantId, doc.title, doc.text, doc.createdAt);
    return doc;
  }

  listDocuments(tenantId: string): Array<Omit<Document, 'text'> & { length: number }> {
    const rows = this.db
      .prepare('SELECT id, title, length(text) AS length, created_at FROM documents WHERE tenant_id = ? ORDER BY created_at DESC')
      .all(tenantId) as Array<{ id: string; title: string; length: number; created_at: string }>;
    return rows.map((r) => ({ id: r.id, title: r.title, length: r.length, createdAt: r.created_at }));
  }

  deleteDocument(tenantId: string, documentId: string): boolean {
    return this.db.prepare('DELETE FROM documents WHERE tenant_id = ? AND id = ?').run(tenantId, documentId).changes > 0;
  }

  /**
   * Keyword search over the company's documents: scores each paragraph by how
   * many query words it contains. Simple on purpose — search by meaning
   * (embeddings) replaces this later without changing its signature.
   */
  searchDocuments(tenantId: string, query: string, limit = 3): Array<{ title: string; excerpt: string; score: number }> {
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
    if (words.length === 0) return [];
    const docs = this.db.prepare('SELECT title, text FROM documents WHERE tenant_id = ?').all(tenantId) as Array<{
      title: string;
      text: string;
    }>;
    const hits: Array<{ title: string; excerpt: string; score: number }> = [];
    for (const doc of docs) {
      for (const paragraph of doc.text.split(/\n\s*\n/)) {
        const lower = paragraph.toLowerCase();
        const score = words.filter((w) => lower.includes(w)).length;
        if (score > 0) hits.push({ title: doc.title, excerpt: paragraph.trim().slice(0, 800), score });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  addNote(tenantId: string, userId: string, text: string): void {
    this.db.prepare('INSERT INTO notes (tenant_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(tenantId, userId, text, now());
  }

  listNotes(tenantId: string, userId: string): Array<{ text: string; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT text, created_at FROM notes WHERE tenant_id = ? AND user_id = ? ORDER BY id DESC')
      .all(tenantId, userId) as Array<{ text: string; created_at: string }>;
    return rows.map((r) => ({ text: r.text, createdAt: r.created_at }));
  }

  // ── Tool rules ──────────────────────────────────────────────────────────

  /** Explicit admin choices for this company; tools not listed use their default. */
  getToolSettings(tenantId: string): Map<string, boolean> {
    const rows = this.db.prepare('SELECT tool_name, enabled FROM tool_settings WHERE tenant_id = ?').all(tenantId) as Array<{
      tool_name: string;
      enabled: number;
    }>;
    return new Map(rows.map((r) => [r.tool_name, r.enabled === 1]));
  }

  setToolEnabled(tenantId: string, toolName: string, enabled: boolean): void {
    this.db
      .prepare(
        'INSERT INTO tool_settings (tenant_id, tool_name, enabled) VALUES (?, ?, ?) ON CONFLICT (tenant_id, tool_name) DO UPDATE SET enabled = excluded.enabled',
      )
      .run(tenantId, toolName, enabled ? 1 : 0);
  }

  // ── Audit log ───────────────────────────────────────────────────────────

  audit(tenantId: string, userId: string | null, event: string, detail: Record<string, unknown> = {}): void {
    this.db
      .prepare('INSERT INTO audit_log (tenant_id, user_id, at, event, detail) VALUES (?, ?, ?, ?, ?)')
      .run(tenantId, userId, now(), event, JSON.stringify(detail));
  }

  /** Newest first. */
  getAudit(tenantId: string, limit = 100): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT at, user_id, event, detail FROM audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ?')
      .all(tenantId, limit) as Array<{ at: string; user_id: string | null; event: string; detail: string }>;
    return rows.map((r) => ({ at: r.at, userId: r.user_id, event: r.event, detail: JSON.parse(r.detail) }));
  }
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
