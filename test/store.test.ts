import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store } from '../src/store.ts';

async function twoCompanies() {
  const store = await Store.open(':memory:');
  const a = await store.createTenantWithAdmin({ companyName: 'Acme', email: 'ann@acme.test', name: 'Ann', passwordHash: 'x' });
  const b = await store.createTenantWithAdmin({ companyName: 'Bolt', email: 'bob@bolt.test', name: 'Bob', passwordHash: 'x' });
  return { store, a, b };
}

test('one company never sees another company’s documents', async () => {
  const { store, a, b } = await twoCompanies();
  const doc = await store.addDocument(a.tenant.id, 'Acme leave policy', 'Acme staff get 25 vacation days.');

  assert.equal((await store.listDocuments(a.tenant.id)).length, 1);
  assert.equal((await store.listDocuments(b.tenant.id)).length, 0);
  assert.deepEqual(await store.searchDocuments(b.tenant.id, 'vacation days'), []);
  assert.equal(await store.deleteDocument(b.tenant.id, doc.id), false, 'another company cannot delete it');
  assert.equal((await store.listDocuments(a.tenant.id)).length, 1);
});

test('conversations, notes and audit entries stay with their company', async () => {
  const { store, a, b } = await twoCompanies();
  const conversation = await store.createConversation(a.tenant.id, a.user.id);
  await store.addMessage(a.tenant.id, conversation, 'user', 'secret plan');
  await store.addNote(a.tenant.id, a.user.id, 'Acme note');
  await store.audit(a.tenant.id, a.user.id, 'question', { text: 'secret plan' });

  assert.equal(await store.ownsConversation(b.tenant.id, b.user.id, conversation), false);
  assert.deepEqual(await store.getMessages(b.tenant.id, conversation), []);
  assert.deepEqual(await store.listNotes(b.tenant.id, a.user.id), []);
  assert.equal((await store.getAudit(b.tenant.id)).length, 0);
  assert.equal(await store.getUser(b.tenant.id, a.user.id), undefined, 'a user id from another company resolves to nobody');
});

test('tool settings are per company', async () => {
  const { store, a, b } = await twoCompanies();
  await store.setToolEnabled(a.tenant.id, 'save_note', true);
  assert.equal((await store.getToolSettings(a.tenant.id)).get('save_note'), true);
  assert.equal((await store.getToolSettings(b.tenant.id)).has('save_note'), false);
});

test('document search ranks the paragraph with the most matching words first', async () => {
  const { store, a } = await twoCompanies();
  await store.addDocument(a.tenant.id, 'Handbook', 'Parking is free.\n\nVacation days: 25 per year.\n\nVacation requests go to your manager.');
  const hits = await store.searchDocuments(a.tenant.id, 'how many vacation days per year');
  assert.equal(hits[0].excerpt, 'Vacation days: 25 per year.');
  assert.equal(hits[0].title, 'Handbook');
});

test('emails are unique across all companies, ignoring case', async () => {
  const { store, a } = await twoCompanies();
  await assert.rejects(store.addUser(a.tenant.id, { email: 'BOB@bolt.test', name: 'Imposter', role: 'member', passwordHash: 'x' }));
});

test('the old SQLite database is copied in once, into an empty database only', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'agent-platform-'));
  try {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
      CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT, name TEXT, role TEXT, password_hash TEXT, created_at TEXT);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, created_at TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, conversation_id TEXT, role TEXT, content TEXT, created_at TEXT);
      CREATE TABLE tool_settings (tenant_id TEXT, tool_name TEXT, enabled INTEGER);
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, user_id TEXT, at TEXT, event TEXT, detail TEXT);
      INSERT INTO tenants VALUES ('t1', 'Acme', '2026-01-01T00:00:00Z');
      INSERT INTO users VALUES ('u1', 't1', 'ann@acme.test', 'Ann', 'admin', 'hash', '2026-01-01T00:00:00Z');
      INSERT INTO conversations VALUES ('c1', 't1', 'u1', '2026-01-01T00:00:01Z');
      INSERT INTO messages (tenant_id, conversation_id, role, content, created_at) VALUES ('t1', 'c1', 'user', 'first', 'x'), ('t1', 'c1', 'assistant', 'second', 'y');
      INSERT INTO tool_settings VALUES ('t1', 'save_note', 1);
      INSERT INTO audit_log (tenant_id, user_id, at, event, detail) VALUES ('t1', 'u1', 'z', 'signed_in', '{"via":"test"}');
    `);
    old.close();

    const store = await Store.open(':memory:');
    const copied = await store.importSqlite(path);
    assert.equal(copied?.users, 1);
    assert.equal((await store.findUserForLogin('ann@acme.test'))?.passwordHash, 'hash', 'passwords keep working');
    assert.deepEqual((await store.getMessages('t1', 'c1')).map((m) => m.content), ['first', 'second']);
    assert.equal(await store.latestConversation('t1', 'u1'), 'c1');
    assert.equal((await store.getToolSettings('t1')).get('save_note'), true);
    assert.deepEqual((await store.getAudit('t1'))[0].detail, { via: 'test' });

    assert.equal(await store.importSqlite(path), null, 'a database that already has companies is left alone');
    assert.equal(await store.importSqlite(join(dir, 'missing.db')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
