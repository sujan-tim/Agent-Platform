import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { hashPassword } from '../src/auth.ts';
import { MockBrain } from '../src/brain/mock.ts';
import type { BrainReply } from '../src/brain/types.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import { SheetService } from '../src/sheetservice.ts';
import { Store } from '../src/store.ts';
import { FakeSheet } from './fakesheet.ts';

const SHEET = '17QfpxMwjLukkZMK1sLqkY8R_xOfxhu17w2iX9yA-lgw';
const OTHER = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const store = await Store.open(':memory:');
const fake = new FakeSheet();
const sheets = new SheetService(store, new Set([SHEET]), () => fake, 'robot@agent.iam.gserviceaccount.com');
const script: BrainReply[] = [];
const brain = new MockBrain(script);
const server = createApp({ config: loadConfig({ AI_PROVIDER: 'mock', SESSION_SECRET: 's' }), store, brain, sheets });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const { tenant } = await store.createTenantWithAdmin({ companyName: 'Client Co', email: 'admin@client.test', name: 'Ada', passwordHash: hashPassword('client admin pw') });
  await store.addUser(tenant.id, { email: 'rep@client.test', name: 'Rui', role: 'member', passwordHash: hashPassword('client member pw') });
  await store.createTenantWithAdmin({ companyName: 'Other Co', email: 'eve@other.test', name: 'Eve', passwordHash: hashPassword('other admin pw') });
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

test('only an admin connects a sheet, only one on the server list, and the company tab is found', async () => {
  const ada = await as('admin@client.test', 'client admin pw');
  const rui = await as('rep@client.test', 'client member pw');
  assert.equal((await ada('GET', '/api/sheet')).body.connection, null);
  assert.equal((await rui('POST', '/api/sheet/connect', { sheet: SHEET })).status, 403, 'members cannot connect');
  assert.equal((await ada('POST', '/api/sheet/connect', { sheet: OTHER })).status, 403, 'not on the server list');

  const link = `https://docs.google.com/spreadsheets/d/${SHEET}/edit?gid=1755264348#gid=1755264348`;
  const connected = await ada('POST', '/api/sheet/connect', { sheet: link });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.tab, 'Companies', 'the tab with a Company Name header');

  const status = (await rui('GET', '/api/sheet')).body;
  assert.equal(status.rows, 8);
  assert.equal(status.columns.length, 21);
  assert.equal((await rui('GET', '/api/me')).body.database, true);
});

test('another company cannot take, see or change the sheet', async () => {
  const eve = await as('eve@other.test', 'other admin pw');
  assert.equal((await eve('POST', '/api/sheet/connect', { sheet: SHEET })).status, 403);
  assert.equal((await eve('GET', '/api/me')).body.database, false);
  script.push({ text: 'ok', toolCalls: [] });
  await eve('POST', '/api/chat', { message: 'list companies' });
  assert.ok(!brain.requests.at(-1)!.tools.some((t) => t.name === 'find_companies'), 'no database tools without a sheet');
});

test('chat: the agent finds, proposes; a member cannot approve; an admin approves and the sheet changes', async () => {
  const rui = await as('rep@client.test', 'client member pw');
  script.push(
    { text: '', toolCalls: [{ id: '1', name: 'find_companies', arguments: { where: [{ column: 'Website', op: 'empty' }] } }] },
    { text: '', toolCalls: [{ id: '2', name: 'propose_company_update', arguments: { company: 'Pan Rico', changes: { Website: 'panrico.mx', Status: 'Contacted' }, reason: 'asked by Rui' } }] },
    { text: 'Done: two changes are waiting for review.', toolCalls: [] },
  );
  const chat = await rui('POST', '/api/chat', { message: 'Pan Rico is panrico.mx and we contacted them' });
  assert.equal(chat.body.reply, 'Done: two changes are waiting for review.');
  assert.deepEqual(chat.body.toolsUsed, ['find_companies', 'propose_company_update']);
  const request = brain.requests.at(-3)!;
  assert.match(request.system, /database of 8 companies in a Google Sheet \("Companies" tab\)/);
  assert.match(request.system, /Status, Channel, Channel Org, Source, Volume \(MT\), Net Sales, Sales Rep are the team's internal data/);

  const pending = (await rui('GET', '/api/sheet/changes')).body.changes;
  assert.deepEqual(pending.map((c: any) => [c.company, c.column, c.oldValue, c.newValue, c.proposedBy]), [
    ['Pan Rico', 'Website', '', 'panrico.mx', 'Rui'],
    ['Pan Rico', 'Status', 'Prospect', 'Contacted', 'Rui'],
  ]);
  const ids = pending.map((c: any) => c.id);
  assert.equal((await rui('POST', '/api/sheet/changes/decide', { ids, decision: 'approve' })).status, 403, 'members cannot approve');

  const ada = await as('admin@client.test', 'client admin pw');
  const decided = await ada('POST', '/api/sheet/changes/decide', { ids, decision: 'approve' });
  assert.deepEqual(decided.body, { applied: 2, rejected: 0, failed: [] });
  const panRico = fake.grid.find((r) => r[0] === 'Pan Rico')!;
  assert.equal(panRico[2], 'panrico.mx');
  assert.equal(panRico[5], 'Contacted');
  assert.equal((await ada('GET', '/api/sheet/changes')).body.changes.length, 0);
  assert.equal((await ada('GET', '/api/sheet/changes?status=applied')).body.changes[0].decidedBy, 'Ada');

  const eve = await as('eve@other.test', 'other admin pw');
  assert.equal((await eve('GET', '/api/sheet/changes?status=all')).body.changes.length, 0, 'other companies never see the queue');
  assert.deepEqual((await eve('POST', '/api/sheet/changes/decide', { ids, decision: 'reject' })).body, { applied: 0, rejected: 0, failed: [] });
});

test('a change that no longer fits the sheet fails safely instead of overwriting', async () => {
  const ada = await as('admin@client.test', 'client admin pw');
  script.push(
    { text: '', toolCalls: [{ id: '1', name: 'propose_company_update', arguments: { company: 'Dulce Vida', changes: { Country: 'Guatemala' }, reason: 'asked' } }] },
    { text: 'Queued.', toolCalls: [] },
  );
  await ada('POST', '/api/chat', { message: 'Dulce Vida moved to Guatemala' });
  const [change] = (await ada('GET', '/api/sheet/changes')).body.changes;
  fake.grid.find((r) => r[0] === 'Dulce Vida')![1] = 'El Salvador';
  await new Promise((r) => setTimeout(r, 10));
  const decided = await ada('POST', '/api/sheet/changes/decide', { ids: [change.id], decision: 'approve' });
  assert.equal(decided.body.applied, 0);
  assert.match(decided.body.failed[0].reason, /changed to "El Salvador" since this was proposed/);
  assert.equal(fake.grid.find((r) => r[0] === 'Dulce Vida')![1], 'El Salvador');
});

test('rejecting leaves the sheet alone, and disconnecting clears the queue', async () => {
  const ada = await as('admin@client.test', 'client admin pw');
  script.push(
    { text: '', toolCalls: [{ id: '1', name: 'propose_new_company', arguments: { values: { 'Company Name': 'Tropico Juices', Country: 'Peru' }, reason: 'trade show' } }] },
    { text: 'Queued.', toolCalls: [] },
  );
  await ada('POST', '/api/chat', { message: 'add Tropico Juices from Peru' });
  const [change] = (await ada('GET', '/api/sheet/changes')).body.changes;
  assert.equal(change.kind, 'add');
  const rows = fake.grid.length;
  assert.equal((await ada('POST', '/api/sheet/changes/decide', { ids: [change.id], decision: 'reject' })).body.rejected, 1);
  assert.equal(fake.grid.length, rows);

  assert.equal((await ada('DELETE', '/api/sheet')).status, 200);
  assert.equal((await ada('GET', '/api/me')).body.database, false);
});
