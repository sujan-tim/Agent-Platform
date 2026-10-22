import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { CompanyDb, normaliseName, parseNumber } from '../src/companydb.ts';
import { columnLetter, GoogleAuth, GoogleSheet } from '../src/google.ts';
import { Store } from '../src/store.ts';
import { findTool, type ToolContext } from '../src/tools.ts';
import { FakeSheet } from './fakesheet.ts';

async function setup() {
  const sheet = new FakeSheet();
  const companies = new CompanyDb(sheet, 'Companies');
  const store = await Store.open(':memory:');
  const { tenant, user } = await store.createTenantWithAdmin({ companyName: 'Acme', email: 'a@a.test', name: 'Ann', passwordHash: 'x' });
  const ctx: ToolContext = { store, tenantId: tenant.id, userId: user.id, companies };
  const run = (name: string, args: Record<string, unknown> = {}) => findTool(name)!.run(ctx, args);
  return { sheet, companies, store, tenantId: tenant.id, run };
}

test('the database learns its columns from the sheet: numbers, lists and internal columns', async () => {
  const { companies } = await setup();
  const profile = Object.fromEntries((await companies.profile()).map((p) => [p.name, p]));
  assert.equal(profile['Net Sales'].numeric, true);
  assert.equal(profile['Volume (MT)'].numeric, true);
  assert.deepEqual(profile.Status.allowed, ['Prospect', 'Customer', 'Contacted', 'Lost']);
  assert.deepEqual(profile['Sales Rep'].allowed, ['Maria', 'John', 'Ana']);
  assert.equal(profile['Company Name'].allowed, undefined, 'the name column is never a list');
  assert.equal(profile['Net Sales'].internal, true);
  assert.equal(profile.Website.internal, false);
  assert.equal((await companies.load()).rows.length, 8, 'blank rows are skipped');
});

test('finding companies by conditions and words', async () => {
  const { run } = await setup();
  const mexico = await run('find_companies', { where: [{ column: 'country', op: 'equals', value: 'mexico' }], columns: ['Sales Rep'] });
  assert.match(mexico, /^2 companies match/);
  assert.match(mexico, /Row 5 · Dulce Vida · Sales Rep: Maria/);

  const noWebsite = await run('find_companies', { where: [{ column: 'Website', op: 'empty' }] });
  assert.match(noWebsite, /^3 companies match/);

  const big = await run('find_companies', { where: [{ column: 'Net Sales', op: 'greater_than', value: '300000' }] });
  assert.match(big, /^3 companies match/);

  assert.match(await run('find_companies', { text: 'oats' }), /Nordic Oats AB/);
  await assert.rejects(async () => run('find_companies', { where: [{ column: 'Colour', op: 'empty' }] }), /no column "Colour". Columns: Company Name, Country/);
});

test('totals by group', async () => {
  const { run } = await setup();
  const out = await run('company_totals', { group_by: 'Country', op: 'sum', measure: 'Net Sales' });
  assert.match(out, /- UK: 780,000 \(1 companies\)/);
  assert.match(out, /- USA: 330,000 \(3 companies\)/);
  assert.match(out, /Total: 1,815,000/);
  assert.match(await run('company_totals', { group_by: 'Status', op: 'count' }), /- Prospect: 4/);
});

test('likely duplicates: the same name without "Inc.", or the same website', async () => {
  const { run } = await setup();
  const out = await run('find_duplicate_companies');
  assert.match(out, /row 3 "Acme Bakery Inc\." \/ row 4 "ACME Bakery"/);
  assert.match(out, /row 3 "Acme Bakery Inc\." \/ row 10 "Bright Dairy Co"/, 'same website domain');
});

test('updates are only proposed, checked, and queued for review', async () => {
  const { run, store, tenantId, sheet } = await setup();
  const before = JSON.stringify(sheet.grid);
  const out = await run('propose_company_update', {
    company: 'Nordic Oats',
    changes: { Website: 'https://nordicoats.se', Country: 'Sweden', Status: 'Qualified', 'Net Sales': 'a lot', Colour: 'blue' },
    reason: 'asked by Ann',
  });
  assert.match(out, /nothing in the sheet has changed yet/);
  assert.match(out, /✓ Website: "\(empty\)" → "https:\/\/nordicoats.se"/);
  assert.match(out, /= Country is already "Sweden"/);
  assert.match(out, /✓ Status: "Prospect" → "Qualified" \(note: "Qualified" is a new value for Status/);
  assert.match(out, /✕ Net Sales takes a number/);
  assert.match(out, /✕ Colour: There is no column "Colour"/);
  assert.equal(JSON.stringify(sheet.grid), before, 'the sheet is untouched');

  const pending = await store.listSheetChanges(tenantId);
  assert.deepEqual(pending.map((c) => [c.column, c.oldValue, c.newValue, c.row]), [
    ['Website', '', 'https://nordicoats.se', 6],
    ['Status', 'Prospect', 'Qualified', 6],
  ]);
  assert.match(await run('propose_company_update', { company: 'Nordic Oats AB', changes: { Website: 'https://nordicoats.se' }, reason: 'again' }), /already waiting for review/);
});

test('internal columns are never filled from the web', async () => {
  const { run } = await setup();
  const out = await run('propose_company_update', {
    company: 'Pan Rico',
    changes: { 'Net Sales': '90000', Website: 'panrico.mx' },
    reason: 'found online',
    sources: ['https://panrico.mx/about'],
  });
  assert.match(out, /✕ Net Sales is the team's internal data/);
  assert.match(out, /✓ Website/);
});

test('ambiguous and unknown companies are not guessed', async () => {
  const { run } = await setup();
  assert.match(await run('propose_company_update', { company: 'Acme Bakery', changes: { Country: 'Canada' }, reason: 'x' }), /Several rows match: row 3 "Acme Bakery Inc\.", row 4 "ACME Bakery"/);
  assert.match(await run('propose_company_update', { company: 'Nobody Ltd', changes: { Country: 'Peru' }, reason: 'x' }), /propose_new_company/);
});

test('a new company is checked for duplicates by name and website before it is proposed', async () => {
  const { run, store, tenantId } = await setup();
  assert.match(await run('propose_new_company', { values: { 'Company Name': 'Green Snacks Limited', Country: 'UK' }, reason: 'x' }), /Possible duplicate: row 7 "Green Snacks Ltd"/);
  assert.match(await run('propose_new_company', { values: { 'Company Name': 'GS Foods', Website: 'https://www.greensnacks.co.uk/shop' }, reason: 'x' }), /Possible duplicate: row 7/);
  const ok = await run('propose_new_company', { values: { 'Company Name': 'Tropico Juices', Country: 'Peru', Website: 'tropico.pe' }, reason: 'from a trade show', sources: ['https://tropico.pe'] });
  assert.match(ok, /Proposed adding Tropico Juices/);
  const [change] = await store.listSheetChanges(tenantId);
  assert.equal(change.kind, 'add');
  assert.deepEqual(JSON.parse(change.newValue), { 'Company Name': 'Tropico Juices', Country: 'Peru', Website: 'tropico.pe' });
  assert.deepEqual(change.sources, ['https://tropico.pe']);
});

test('an approved change is written only if the row still holds the same company and old value', async () => {
  const { companies, sheet } = await setup();
  assert.deepEqual(await companies.applyUpdate({ row: 6, company: 'Nordic Oats AB', column: 'Website', oldValue: '', newValue: 'nordicoats.se' }), { ok: true });
  assert.equal(sheet.grid[5][2], 'nordicoats.se');

  // Someone edits the sheet before the next approval.
  sheet.grid[5][1] = 'Norway';
  const stale = await companies.applyUpdate({ row: 6, company: 'Nordic Oats AB', column: 'Country', oldValue: 'Sweden', newValue: 'Finland' });
  assert.deepEqual(stale, { ok: false, reason: 'Country for Nordic Oats AB changed to "Norway" since this was proposed.' });

  // Someone inserts a row, so the company moves.
  sheet.grid.splice(1, 0, ['New Co']);
  const moved = await companies.applyUpdate({ row: 6, company: 'Nordic Oats AB', column: 'Country', oldValue: 'Norway', newValue: 'Finland' });
  assert.equal(moved.ok, false);

  assert.deepEqual(await companies.applyAdd({ 'Company Name': 'Tropico Juices', Country: 'Peru' }), { ok: true });
  assert.equal(sheet.grid.at(-1)![0], 'Tropico Juices');
  assert.equal(sheet.grid.at(-1)!.length, 21, 'a full row, in column order');
  assert.equal((await companies.applyAdd({ 'Company Name': 'Tropico Juices S.A.' })).ok, false, 'not added twice');
});

test('reads are cached briefly to stay inside Google limits', async () => {
  const { companies, sheet } = await setup();
  await companies.load();
  await companies.profile();
  await companies.find({});
  assert.equal(sheet.reads, 1);
  await companies.load(true);
  assert.equal(sheet.reads, 2);
});

test('numbers, names and column letters', () => {
  assert.equal(parseNumber('$1,250,000'), 1_250_000);
  assert.equal(parseNumber('1.2M'), 1_200_000);
  assert.equal(parseNumber('500 MT'), 500);
  assert.equal(parseNumber('2024-01-05'), null);
  assert.equal(parseNumber('N/A'), null);
  assert.equal(normaliseName('Sabor Foods S.A.'), normaliseName('SABOR FOODS'));
  assert.equal(columnLetter(1), 'A');
  assert.equal(columnLetter(21), 'U');
  assert.equal(columnLetter(28), 'AB');
});

test('Google sign-in: a signed token request, then Sheets calls with the token', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const seen: Record<string, unknown> = {};
  const google = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/token') {
        const assertion = new URLSearchParams(body).get('assertion')!;
        const [header, claims, signature] = assertion.split('.');
        seen.signed = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url'));
        seen.claims = JSON.parse(Buffer.from(claims, 'base64url').toString());
        res.end(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }));
        return;
      }
      seen.auth = req.headers.authorization;
      seen.path = req.url;
      if (req.url?.includes('batchUpdate')) seen.write = JSON.parse(body);
      res.end(JSON.stringify(req.url?.includes('/values/') ? { values: [['Company Name'], ['X']] } : { sheets: [{ properties: { title: 'Companies' } }] }));
    });
  });
  await new Promise<void>((resolve) => google.listen(0, resolve));
  const base = `http://localhost:${(google.address() as AddressInfo).port}`;
  try {
    const auth = new GoogleAuth({ client_email: 'robot@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: `${base}/token` });
    const sheet = new GoogleSheet(auth, 'sheet123', `${base}/v4/spreadsheets`);
    assert.deepEqual(await sheet.tabs(), ['Companies']);
    assert.equal(seen.signed, true);
    assert.equal((seen.claims as any).iss, 'robot@p.iam.gserviceaccount.com');
    assert.equal((seen.claims as any).scope, 'https://www.googleapis.com/auth/spreadsheets');
    assert.equal(seen.auth, 'Bearer tok-1');
    assert.deepEqual(await sheet.read("Bob's tab"), [['Company Name'], ['X']]);
    assert.match(String(seen.path), /\/values\/'Bob''s%20tab'/);
    await sheet.write('Companies', [{ row: 6, column: 3, value: 'x.com' }]);
    assert.deepEqual((seen.write as any).data, [{ range: "'Companies'!C6", values: [['x.com']] }]);
  } finally {
    google.close();
  }
});
