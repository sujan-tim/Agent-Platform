import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { hashPassword } from '../src/auth.ts';
import { MockBrain } from '../src/brain/mock.ts';
import type { BrainReply } from '../src/brain/types.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store.ts';

const store = await Store.open(':memory:');
const script: BrainReply[] = [];
const brain = new MockBrain(script);
const server = createApp({ config: loadConfig({ AI_PROVIDER: 'mock', SESSION_SECRET: 's' }), store, brain });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const { tenant } = await store.createTenantWithAdmin({ companyName: 'Acme', email: 'ada@acme.test', name: 'Ada', passwordHash: hashPassword('admin password') });
  await store.addUser(tenant.id, { email: 'rui@acme.test', name: 'Rui', role: 'member', passwordHash: hashPassword('member password') });
  await store.createTenantWithAdmin({ companyName: 'Other', email: 'eve@other.test', name: 'Eve', passwordHash: hashPassword('other password') });
});
after(() => {
  server.close();
});

async function as(email: string, password: string) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as any };
  };
}

const remember = (fact: string): BrainReply => ({ text: '', toolCalls: [{ id: 'm', name: 'remember_for_team', arguments: { fact } }] });

test('the master prompt is set by admins and reaches every chat', async () => {
  const ada = await as('ada@acme.test', 'admin password');
  const rui = await as('rui@acme.test', 'member password');
  assert.equal((await rui('PUT', '/api/admin/master-prompt', { text: 'Be rude.' })).status, 403);
  assert.equal((await ada('PUT', '/api/admin/master-prompt', { text: 'x'.repeat(2001) })).status, 400);
  await ada('PUT', '/api/admin/master-prompt', { text: 'Answer in English and Spanish. Net Sales is in USD.' });
  assert.equal((await ada('GET', '/api/admin/master-prompt')).body.text, 'Answer in English and Spanish. Net Sales is in USD.');

  script.push({ text: 'ok', toolCalls: [] });
  await rui('POST', '/api/chat', { message: 'hi' });
  assert.match(brain.requests.at(-1)!.system, /<company_instructions>\nAnswer in English and Spanish\. Net Sales is in USD\.\n<\/company_instructions>/);
});

test("a member's memory waits for approval; an admin's is saved at once", async () => {
  const rui = await as('rui@acme.test', 'member password');
  script.push(remember('Maria now covers Mexico'), { text: 'Sent for approval.', toolCalls: [] });
  await rui('POST', '/api/chat', { message: 'remember for the team that Maria now covers Mexico' });
  assert.match(brain.requests.at(-1)!.messages.at(-1)!.content, /Sent for approval/);

  const ada = await as('ada@acme.test', 'admin password');
  const listed = (await ada('GET', '/api/admin/memories')).body;
  assert.deepEqual(listed.pending.map((m: any) => [m.text, m.createdBy]), [['Maria now covers Mexico', 'Rui']]);
  assert.deepEqual(listed.active, []);

  script.push({ text: 'ok', toolCalls: [] });
  await ada('POST', '/api/chat', { message: 'hello' });
  assert.doesNotMatch(brain.requests.at(-1)!.system, /Maria now covers Mexico/, 'not used until approved');

  assert.equal((await rui('POST', '/api/admin/memories/decide', { id: listed.pending[0].id, decision: 'approve' })).status, 403);
  await ada('POST', '/api/admin/memories/decide', { id: listed.pending[0].id, decision: 'approve' });

  script.push(remember('Quote prices in USD'), { text: 'Saved.', toolCalls: [] });
  await ada('POST', '/api/chat', { message: 'remember for the team: quote prices in USD' });
  assert.match(brain.requests.at(-1)!.messages.at(-1)!.content, /Saved to the team memory/);

  script.push({ text: 'ok', toolCalls: [] });
  await rui('POST', '/api/chat', { message: 'who covers Mexico?' });
  assert.match(brain.requests.at(-1)!.system, /Team memory[^\n]*\n- Quote prices in USD\n- Maria now covers Mexico/);
});

test('memories can be added and deleted by admins, and never cross companies', async () => {
  const ada = await as('ada@acme.test', 'admin password');
  await ada('POST', '/api/admin/memories', { text: 'Our fiscal year starts in October' });
  const { active } = (await ada('GET', '/api/admin/memories')).body;
  assert.equal(active[0].text, 'Our fiscal year starts in October');

  const eve = await as('eve@other.test', 'other password');
  assert.deepEqual((await eve('GET', '/api/admin/memories')).body.active, []);
  assert.equal((await eve('DELETE', `/api/admin/memories?id=${active[0].id}`)).status, 404);
  script.push({ text: 'ok', toolCalls: [] });
  await eve('POST', '/api/chat', { message: 'hi' });
  assert.doesNotMatch(brain.requests.at(-1)!.system, /fiscal year|Maria|company_instructions/);

  assert.equal((await ada('DELETE', `/api/admin/memories?id=${active[0].id}`)).status, 200);
  assert.ok(!(await ada('GET', '/api/admin/memories')).body.active.some((m: any) => m.text.includes('fiscal')));
});

test('the same memory is not stored twice', async () => {
  const ada = await as('ada@acme.test', 'admin password');
  script.push(remember('quote prices in usd'), { text: 'ok', toolCalls: [] });
  await ada('POST', '/api/chat', { message: 'remember: quote prices in USD' });
  assert.match(brain.requests.at(-1)!.messages.at(-1)!.content, /already has that/);
});
