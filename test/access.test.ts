import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { hashPassword } from '../src/auth.ts';
import { MockBrain } from '../src/brain/mock.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store.ts';

const store = await Store.open(':memory:');
// No ALLOW_SIGNUP: the default, as on a real server.
const server = createApp({ config: loadConfig({ AI_PROVIDER: 'mock', SESSION_SECRET: 's' }), store, brain: new MockBrain() });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await store.createTenantWithAdmin({ companyName: 'Owner Co', email: 'owner@owner.test', name: 'Olu', passwordHash: hashPassword('owner password') });
  await store.createTenantWithAdmin({ companyName: 'Other Co', email: 'eve@other.test', name: 'Eve', passwordHash: hashPassword('other password') });
});
after(() => {
  server.close();
});

const call = async (method: string, path: string, body?: unknown, cookie = '') => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
};
const signIn = async (email: string, password: string) => (await call('POST', '/api/login', { email, password })).cookie;

test('nobody can create a company from the sign-in page unless the server allows it', async () => {
  assert.deepEqual((await call('GET', '/api/public')).body, { allowSignup: false, accessRequests: false });
  const signup = await call('POST', '/api/signup', { companyName: 'Sneaky', name: 'S', email: 's@s.test', password: 'long enough pw' });
  assert.equal(signup.status, 403);
  assert.equal(await store.findUserForLogin('s@s.test'), undefined);
});

test('access requests are off until an admin turns them on, and only one company receives them', async () => {
  assert.equal((await call('POST', '/api/access-requests', { name: 'Ann', email: 'ann@x.test', password: 'ann password 1' })).status, 403);

  const owner = await signIn('owner@owner.test', 'owner password');
  assert.equal((await call('PUT', '/api/admin/access-requests', { enabled: true }, owner)).status, 200);
  assert.equal((await call('GET', '/api/public')).body.accessRequests, true);

  const eve = await signIn('eve@other.test', 'other password');
  assert.equal((await call('PUT', '/api/admin/access-requests', { enabled: true }, eve)).status, 409);
  assert.equal((await call('GET', '/api/admin/access-requests', undefined, eve)).body.takenElsewhere, true);
});

test('a request waits; the person is told so; the admin approves and they can sign in', async () => {
  const sent = await call('POST', '/api/access-requests', { name: 'Ann', email: 'Ann@X.test', password: 'ann password 1', note: 'Sales team' });
  assert.equal(sent.status, 200);

  const early = await call('POST', '/api/login', { email: 'ann@x.test', password: 'ann password 1' });
  assert.equal(early.status, 403);
  assert.match(early.body.error, /waiting for an admin to approve/);
  assert.equal((await call('POST', '/api/login', { email: 'ann@x.test', password: 'a wrong guess!' })).status, 401, 'a wrong password reveals nothing');

  const owner = await signIn('owner@owner.test', 'owner password');
  const { requests } = (await call('GET', '/api/admin/access-requests', undefined, owner)).body;
  assert.deepEqual(requests.map((r: any) => [r.name, r.email, r.note]), [['Ann', 'ann@x.test', 'Sales team']]);
  assert.equal(JSON.stringify(requests).includes('hash'), false, 'password hashes never leave the server');

  const eve = await signIn('eve@other.test', 'other password');
  assert.deepEqual((await call('GET', '/api/admin/access-requests', undefined, eve)).body.requests, [], 'other companies never see them');
  assert.equal((await call('POST', '/api/admin/access-requests/decide', { id: requests[0].id, decision: 'approve' }, eve)).status, 404);

  assert.equal((await call('POST', '/api/admin/access-requests/decide', { id: requests[0].id, decision: 'approve', role: 'member' }, owner)).status, 200);
  const ann = await call('POST', '/api/login', { email: 'ann@x.test', password: 'ann password 1' });
  assert.equal(ann.status, 200);
  assert.equal(ann.body.companyName, 'Owner Co');
  assert.equal(ann.body.role, 'member');
});

test('a rejected request cannot sign in, and asking with an existing email reveals nothing', async () => {
  await call('POST', '/api/access-requests', { name: 'Bo', email: 'bo@x.test', password: 'bo password 12' });
  const owner = await signIn('owner@owner.test', 'owner password');
  const [request] = (await call('GET', '/api/admin/access-requests', undefined, owner)).body.requests;
  await call('POST', '/api/admin/access-requests/decide', { id: request.id, decision: 'reject' }, owner);
  assert.equal((await call('POST', '/api/login', { email: 'bo@x.test', password: 'bo password 12' })).status, 401);

  const existing = await call('POST', '/api/access-requests', { name: 'Fake Eve', email: 'eve@other.test', password: 'takeover attempt' });
  assert.equal(existing.status, 200, 'same answer as for a new email');
  assert.deepEqual((await call('GET', '/api/admin/access-requests', undefined, owner)).body.requests, []);
  assert.equal((await call('POST', '/api/login', { email: 'eve@other.test', password: 'other password' })).status, 200, 'the real account is untouched');
});

test('members cannot see or decide requests, and turning requests off hides the form', async () => {
  const ann = await signIn('ann@x.test', 'ann password 1');
  assert.equal((await call('GET', '/api/admin/access-requests', undefined, ann)).status, 403);
  const owner = await signIn('owner@owner.test', 'owner password');
  await call('PUT', '/api/admin/access-requests', { enabled: false }, owner);
  assert.equal((await call('GET', '/api/public')).body.accessRequests, false);
  assert.equal((await call('POST', '/api/access-requests', { name: 'Cy', email: 'cy@x.test', password: 'cy password 12' })).status, 403);
});

test('on a server with one company, registering is on for it until its admin turns it off', async () => {
  const solo = await Store.open(':memory:');
  assert.equal(await solo.accessRequestsTenant(), undefined, 'no company yet');
  const { tenant } = await solo.createTenantWithAdmin({ companyName: 'Solo', email: 'solo@s.test', name: 'Sol', passwordHash: 'x' });
  assert.equal(await solo.accessRequestsTenant(), tenant.id);
  // Remembered, so a second company appearing later does not switch it off.
  await solo.createTenantWithAdmin({ companyName: 'Later', email: 'l@l.test', name: 'L', passwordHash: 'x' });
  assert.equal(await solo.accessRequestsTenant(), tenant.id);
  assert.equal(await solo.setAccessRequestsTenant(tenant.id, false), true);
  assert.equal(await solo.accessRequestsTenant(), undefined, 'off stays off');
  assert.equal(await solo.setAccessRequestsTenant(tenant.id, true), true);
  assert.equal(await solo.accessRequestsTenant(), tenant.id);
});
