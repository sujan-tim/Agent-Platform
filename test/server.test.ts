import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { verifySession, signSession, hashPassword, verifyPassword } from '../src/auth.ts';
import { MockBrain } from '../src/brain/mock.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store.ts';

const config = loadConfig({ AI_PROVIDER: 'mock', SESSION_SECRET: 'test-secret' });
const store = new Store(':memory:');
const server = createApp({ config, store, brain: new MockBrain() });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
});

/** A tiny client that keeps its own session cookie, like one browser. */
function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: (await res.json()) as any };
  };
}

test('sign up, chat, and keep the conversation', async () => {
  const ann = client();
  const signup = await ann('POST', '/api/signup', { companyName: 'Acme', name: 'Ann', email: 'ann@acme.test', password: 'correct horse battery' });
  assert.equal(signup.status, 200);
  assert.equal(signup.body.role, 'admin');

  const chat = await ann('POST', '/api/chat', { message: 'hello there' });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.reply, '(mock brain) You said: hello there');

  const history = await ann('GET', '/api/history');
  assert.equal(history.body.conversationId, chat.body.conversationId);
  assert.deepEqual(history.body.messages.map((m: any) => m.role), ['user', 'assistant']);
});

test('signed-out requests and bad passwords are refused', async () => {
  const stranger = client();
  assert.equal((await stranger('GET', '/api/me')).status, 401);
  assert.equal((await stranger('POST', '/api/chat', { message: 'hi' })).status, 401);
  const login = await stranger('POST', '/api/login', { email: 'ann@acme.test', password: 'wrong password!' });
  assert.equal(login.status, 401);
});

test('two companies cannot see each other’s documents or conversations', async () => {
  const ann = client();
  await ann('POST', '/api/login', { email: 'ann@acme.test', password: 'correct horse battery' });
  await ann('POST', '/api/documents', { title: 'Acme secrets', text: 'The launch code is pineapple.' });
  const annChat = await ann('POST', '/api/chat', { message: 'hi' });

  const bob = client();
  await bob('POST', '/api/signup', { companyName: 'Bolt', name: 'Bob', email: 'bob@bolt.test', password: 'another long password' });
  assert.deepEqual((await bob('GET', '/api/documents')).body.documents, []);

  const search = await bob('POST', '/api/chat', { message: 'search documents for the launch code' });
  assert.doesNotMatch(search.body.reply, /pineapple/);

  const hijack = await bob('POST', '/api/chat', { message: 'hi', conversationId: annChat.body.conversationId });
  assert.equal(hijack.status, 404);
});

test('members cannot use admin routes; admins can add members and change tools', async () => {
  const ann = client();
  await ann('POST', '/api/login', { email: 'ann@acme.test', password: 'correct horse battery' });
  const added = await ann('POST', '/api/admin/users', { name: 'Max', email: 'max@acme.test', password: 'member password 1', role: 'member' });
  assert.equal(added.status, 200);

  const max = client();
  await max('POST', '/api/login', { email: 'max@acme.test', password: 'member password 1' });
  assert.equal((await max('GET', '/api/admin/tools')).status, 403);
  assert.equal((await max('POST', '/api/documents', { title: 't', text: 'x' })).status, 403);

  const tools = await ann('PUT', '/api/admin/tools', { name: 'save_note', enabled: true });
  assert.equal(tools.body.tools.find((t: any) => t.name === 'save_note').enabled, true);
  const audit = await ann('GET', '/api/admin/audit');
  assert.ok(audit.body.entries.some((e: any) => e.event === 'tool_setting_changed'));
});

test('state-changing requests must be JSON', async () => {
  const res = await fetch(`${base}/api/login`, { method: 'POST', body: 'email=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 415);
});

test('the web app is served, and nothing outside web/ is', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Agent Platform/);
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/src/server.ts`)).status, 404);
});

test('sessions: a tampered or expired token is rejected', () => {
  const token = signSession({ tenantId: 't', userId: 'u', expiresAt: Date.now() + 1000 }, 'k');
  assert.ok(verifySession(token, 'k'));
  assert.equal(verifySession(token, 'other key'), null);
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ tenantId: 'x', userId: 'u', expiresAt: Date.now() + 1000 })).toString('base64url');
  assert.equal(verifySession(`${forged}.${signature}`, 'k'), null);
  assert.equal(verifySession(`${payload}.${signature}`, 'k', Date.now() + 2000), null);
});

test('passwords are hashed, not stored', () => {
  const hash = hashPassword('my long password');
  assert.doesNotMatch(hash, /my long password/);
  assert.ok(verifyPassword('my long password', hash));
  assert.ok(!verifyPassword('wrong', hash));
});
