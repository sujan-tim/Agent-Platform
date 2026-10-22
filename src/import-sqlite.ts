/**
 * Copies everything from the old SQLite database (data/agent-platform.db,
 * used before the move to Postgres) into the current database.
 *
 * Runs only into an empty database (no companies yet), in one transaction, so
 * it can never mix two sets of data or leave half a copy. Row order is kept,
 * so conversations and the audit log read in the same order as before.
 */

import { existsSync } from 'node:fs';

import type { Db } from './db.ts';

/** Tables in an order that satisfies their references, with the columns to copy. */
const TABLES: Array<{ name: string; columns: string[]; orderBy: string }> = [
  { name: 'tenants', columns: ['id', 'name', 'created_at'], orderBy: 'rowid' },
  { name: 'users', columns: ['id', 'tenant_id', 'email', 'name', 'role', 'password_hash', 'created_at'], orderBy: 'rowid' },
  { name: 'conversations', columns: ['id', 'tenant_id', 'user_id', 'created_at'], orderBy: 'created_at, rowid' },
  { name: 'messages', columns: ['tenant_id', 'conversation_id', 'role', 'content', 'created_at'], orderBy: 'id' },
  { name: 'documents', columns: ['id', 'tenant_id', 'title', 'text', 'created_at'], orderBy: 'rowid' },
  {
    name: 'document_chunks',
    columns: ['tenant_id', 'document_id', 'position', 'text', 'embedding', 'embedding_model'],
    orderBy: 'id',
  },
  { name: 'notes', columns: ['tenant_id', 'user_id', 'text', 'created_at'], orderBy: 'id' },
  { name: 'tool_settings', columns: ['tenant_id', 'tool_name', 'enabled'], orderBy: 'rowid' },
  { name: 'audit_log', columns: ['tenant_id', 'user_id', 'at', 'event', 'detail'], orderBy: 'id' },
];

/** Returns rows copied per table, or null if there was nothing to do. */
export async function importSqlite(db: Db, sqlitePath: string): Promise<Record<string, number> | null> {
  if (!existsSync(sqlitePath)) return null;
  const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM tenants');
  if (n > 0) return null;

  // Loaded only when there is a file to copy, so a hosted server never loads SQLite.
  const { DatabaseSync } = await import('node:sqlite');
  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const present = new Set(
      (source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name),
    );
    const copied: Record<string, number> = {};
    await db.transaction(async (tx) => {
      for (const table of TABLES) {
        if (!present.has(table.name)) continue;
        const rows = source.prepare(`SELECT ${table.columns.join(', ')} FROM ${table.name} ORDER BY ${table.orderBy}`).all() as Array<
          Record<string, unknown>
        >;
        const placeholders = table.columns.map((_, i) => `$${i + 1}`).join(', ');
        const insert = `INSERT INTO ${table.name} (${table.columns.join(', ')}) VALUES (${placeholders})`;
        for (const row of rows) {
          await tx.query(
            insert,
            table.columns.map((column) => convert(table.name, column, row[column])),
          );
        }
        copied[table.name] = rows.length;
      }
    });
    return copied;
  } finally {
    source.close();
  }
}

/** SQLite stored booleans as 0/1; Postgres wants true/false. */
function convert(table: string, column: string, value: unknown): unknown {
  if (table === 'tool_settings' && column === 'enabled') return value === 1 || value === 1n;
  return value;
}
