/**
 * The database connection: real Postgres when hosted, PGlite on a laptop.
 *
 * Both speak the same SQL (PGlite is Postgres compiled to WebAssembly and run
 * inside Node), so the store is written once. Which one is used depends on
 * where the data lives:
 * - `postgres://…` or `postgresql://…`: a Postgres server, such as Neon;
 * - `:memory:`: a throwaway database, for the tests;
 * - any other value: a folder on disk that PGlite keeps the database in.
 */

import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Queryable {
  /** Runs one statement with $1, $2… parameters and returns its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs several statements, without parameters (for the schema). */
  exec(sql: string): Promise<void>;
  /** Runs `work` in a transaction: all of it is saved, or none of it. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(location: string): Promise<Db> {
  if (/^postgres(ql)?:\/\//.test(location)) return openPostgres(location);
  if (location !== ':memory:') mkdirSync(location, { recursive: true });
  const db = await PGlite.create(location === ':memory:' ? undefined : location);
  const run = async <T>(target: Pick<PGlite, 'query'>, sql: string, params?: unknown[]) =>
    (await target.query<T>(sql, params)).rows;
  return {
    query: (sql, params) => run(db, sql, params),
    exec: async (sql) => {
      await db.exec(sql);
    },
    transaction: (work) => db.transaction((tx) => work({ query: (sql, params) => run(tx, sql, params) })),
    close: () => db.close(),
  };
}

function openPostgres(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  // A dropped idle connection (Neon suspends idle databases) must not crash the server.
  pool.on('error', (err) => console.warn(`Database connection dropped: ${err.message}`));
  return {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (work) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({ query: async (sql, params) => (await client.query(sql, params)).rows });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
