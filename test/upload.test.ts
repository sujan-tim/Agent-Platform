import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { hashPassword } from '../src/auth.ts';
import { MockBrain } from '../src/brain/mock.ts';
import { loadConfig } from '../src/config.ts';
import type { Embedder } from '../src/embed.ts';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { makeDocx, makePdf } from './fixtures.ts';

/** Fails until `working` is set, like Ollama before the model is pulled. */
class SwitchableEmbedder implements Embedder {
  readonly model = 'test:switchable';
  working = false;
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.working) throw new Error('model not pulled');
    return texts.map((t) => Float32Array.from([t.length, 1]));
  }
}

const store = await Store.open(':memory:');
const embedder = new SwitchableEmbedder();
const server = createApp({
  config: loadConfig({ AI_PROVIDER: 'mock', SESSION_SECRET: 'test-secret' }),
  store,
  brain: new MockBrain(),
  embedder,
});
let base = '';
let tenantId = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const { tenant } = await store.createTenantWithAdmin({ companyName: 'Acme', email: 'ann@acme.test', name: 'Ann', passwordHash: hashPassword('correct horse battery') });
  tenantId = tenant.id;
  await store.addUser(tenant.id, { email: 'max@acme.test', name: 'Max', role: 'member', passwordHash: hashPassword('member password 1') });
});
after(() => {
  server.close();
});

async function signIn(email: string, password: string) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json()) as any };
  };
}

const upload = (filename: string, data: Buffer, title?: string) => ({ filename, title, data: data.toString('base64') });

test('an admin uploads a PDF and the agent answers from it', async () => {
  embedder.working = true;
  const ann = await signIn('ann@acme.test', 'correct horse battery');
  const res = await ann('POST', '/api/documents/upload', upload('Remote Policy.pdf', makePdf(['Remote work is allowed on Fridays.'])));
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Remote Policy', 'title comes from the file name');
  assert.equal(res.body.searchableBy, 'meaning');

  const chat = await ann('POST', '/api/chat', { message: 'search documents for remote work' });
  assert.match(chat.body.reply, /allowed on Fridays/);
  const audit = await ann('GET', '/api/admin/audit');
  assert.ok(audit.body.entries.some((e: any) => e.event === 'document_added' && e.detail.source === 'pdf'));
});

test('an admin uploads a Word file with its own title', async () => {
  const ann = await signIn('ann@acme.test', 'correct horse battery');
  const res = await ann('POST', '/api/documents/upload', upload('exp.docx', makeDocx(['Expenses over $500 need approval.']), 'Expense rules'));
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Expense rules');
  assert.match((await store.searchDocuments(tenantId, 'expenses approval'))[0].excerpt, /over \$500/);
});

test('when embeddings fail the document is still saved, searchable by keywords, and the failure is logged', async () => {
  embedder.working = false;
  const ann = await signIn('ann@acme.test', 'correct horse battery');
  const res = await ann('POST', '/api/documents/upload', upload('parking.txt', Buffer.from('Parking is free after 6pm.')));
  assert.equal(res.status, 200);
  assert.equal(res.body.searchableBy, 'keywords');
  assert.match((await store.searchDocuments(tenantId, 'parking'))[0].excerpt, /free after 6pm/);
  const audit = await ann('GET', '/api/admin/audit');
  assert.ok(audit.body.entries.some((e: any) => e.event === 'embedding_failed'));
});

test('bad uploads are refused with a reason', async () => {
  const ann = await signIn('ann@acme.test', 'correct horse battery');
  const exe = await ann('POST', '/api/documents/upload', upload('tool.exe', Buffer.from('MZ binary')));
  assert.equal(exe.status, 400);
  assert.match(exe.body.error, /PDF, Word/);

  const oldWord = await ann('POST', '/api/documents/upload', upload('old.doc', Buffer.from('binary')));
  assert.match(oldWord.body.error, /\.docx/);

  const blankPdf = await ann('POST', '/api/documents/upload', upload('scan.pdf', makePdf([])));
  assert.equal(blankPdf.status, 400);
  assert.match(blankPdf.body.error, /scan/);

  const brokenPdf = await ann('POST', '/api/documents/upload', upload('broken.pdf', Buffer.from('%PDF-1.4 not really')));
  assert.equal(brokenPdf.status, 400);

  const empty = await ann('POST', '/api/documents/upload', upload('empty.txt', Buffer.alloc(0)));
  assert.equal(empty.status, 400);
});

test('members cannot upload', async () => {
  const max = await signIn('max@acme.test', 'member password 1');
  const res = await max('POST', '/api/documents/upload', upload('x.txt', Buffer.from('hello')));
  assert.equal(res.status, 403);
});

test('the app reports which search it uses', async () => {
  const ann = await signIn('ann@acme.test', 'correct horse battery');
  assert.equal((await ann('GET', '/api/me')).body.search, 'meaning');
});
