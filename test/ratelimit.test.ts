import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { hashPassword } from '../src/auth.ts';
import { MockBrain } from '../src/brain/mock.ts';
import { loadConfig } from '../src/config.ts';
import { RateLimiter } from '../src/ratelimit.ts';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store.ts';

test('the limiter refuses past the limit and recovers when the window passes', async () => {
  let clock = 0;
  const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, () => clock);
  limiter.record('k');
  assert.equal(limiter.retryAfter('k'), 0);
  limiter.record('k');
  assert.equal(limiter.retryAfter('k'), 1000);
  clock = 400;
  assert.equal(limiter.retryAfter('k'), 600);
  assert.equal(limiter.retryAfter('other'), 0, 'keys are counted separately');
  clock = 1001;
  assert.equal(limiter.retryAfter('k'), 0);
  limiter.record('k');
  limiter.record('k');
  limiter.clear('k');
  assert.equal(limiter.retryAfter('k'), 0);
});

const store = await Store.open(':memory:');
const server = createApp({
  config: loadConfig({ AI_PROVIDER: 'mock', SESSION_SECRET: 'test-secret' }),
  store,
  brain: new MockBrain(),
  limits: { email: { max: 3, windowMs: 60_000 }, address: { max: 12, windowMs: 60_000 } },
});
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await store.createTenantWithAdmin({ companyName: 'Acme', email: 'ann@acme.test', name: 'Ann', passwordHash: hashPassword('correct horse battery') });
  await store.createTenantWithAdmin({ companyName: 'Acme', email: 'cat@acme.test', name: 'Cat', passwordHash: hashPassword('another long password') });
});
after(() => {
  server.close();
});

const login = (email: string, password: string) =>
  fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });

test('repeated wrong passwords lock that email, even for the right password, without locking others', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await login('ann@acme.test', 'wrong guess!!')).status, 401);

  const locked = await login('ANN@acme.test', 'correct horse battery');
  assert.equal(locked.status, 429, 'email case does not get around the lock');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.match(((await locked.json()) as { error: string }).error, /Too many attempts/);

  assert.equal((await login('cat@acme.test', 'another long password')).status, 200, 'a colleague is not locked out');

  const tenantId = (await store.findUserForLogin('ann@acme.test'))!.tenantId;
  assert.equal((await store.getAudit(tenantId)).filter((e) => e.event === 'sign_in_failed').length, 3);
});

test('behind a trusted local proxy, each visitor is limited by their own address', async () => {
  const proxied = createApp({
    config: loadConfig({ AI_PROVIDER: 'mock', SESSION_SECRET: 'test-secret', TRUST_PROXY: 'true' }),
    store,
    brain: new MockBrain(),
    limits: { email: { max: 100, windowMs: 60_000 }, address: { max: 2, windowMs: 60_000 } },
  });
  await new Promise<void>((resolve) => proxied.listen(0, resolve));
  try {
    const url = `http://localhost:${(proxied.address() as AddressInfo).port}/api/login`;
    const from = (ip: string) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ email: 'x@y.test', password: 'nope nope nope' }) });
    assert.equal((await from('203.0.113.1')).status, 401);
    assert.equal((await from('203.0.113.1')).status, 401);
    assert.equal((await from('203.0.113.1')).status, 429, 'that visitor is limited');
    assert.equal((await from('203.0.113.2')).status, 401, 'another visitor is not');
  } finally {
    proxied.close();
  }
});

test('one address cannot keep trying sign-ins and sign-ups', async () => {
  // Earlier tests used 5 of this address's 12 attempts.
  for (let i = 0; i < 7; i++) await login(`nobody${i}@acme.test`, 'whatever123');
  assert.equal((await login('cat@acme.test', 'another long password')).status, 429);
  const signup = await fetch(`${base}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ companyName: 'Spam', name: 'S', email: 'spam@spam.test', password: 'spam spam spam' }),
  });
  assert.equal(signup.status, 429);
});
