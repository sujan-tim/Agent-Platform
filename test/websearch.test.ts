import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { runAgent, systemPrompt } from '../src/agent.ts';
import { MockBrain } from '../src/brain/mock.ts';
import { Store } from '../src/store.ts';
import { findTool } from '../src/tools.ts';
import { TavilySearcher, type WebSearcher } from '../src/websearch.ts';

/** A stand-in for Tavily that records requests and answers from a script. */
const replies: Array<{ status: number; body: unknown }> = [];
const requests: any[] = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    const next = replies.shift()!;
    res.writeHead(next.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(next.body));
  });
});
let tavily: TavilySearcher;

before(async () => {
  await new Promise<void>((resolve) => fake.listen(0, resolve));
  tavily = new TavilySearcher('tvly-test', `http://localhost:${(fake.address() as AddressInfo).port}`);
});
after(() => {
  fake.close();
});

test('web search asks Tavily and returns results as quoted material with links', async () => {
  replies.push({
    status: 200,
    body: { results: [{ title: 'Big "news" <today>', url: 'https://example.com/a', content: 'Something happened.', published_date: '2026-10-22' }] },
  });
  const out = await findTool('web_search')!.run({ store: null as never, tenantId: 't', userId: 'u', web: tavily }, { query: 'latest news', news: true, days: 3 });

  const sent = requests.at(-1);
  assert.equal(sent.path, '/search');
  assert.equal(sent.auth, 'Bearer tvly-test');
  assert.equal(sent.body.topic, 'news');
  assert.equal(sent.body.time_range, 'week', '3 days rounds up to a week');
  assert.match(out, /<web_result title="Big 'news' ‹today›" url="https:\/\/example.com\/a" published="2026-10-22">/);
  assert.match(out, /Something happened\./);
});

test('reading a page returns its text, cut to a sensible length', async () => {
  replies.push({ status: 200, body: { results: [{ url: 'https://example.com/a', raw_content: 'x'.repeat(20_000) }], failed_results: [] } });
  const out = await findTool('read_web_page')!.run({ store: null as never, tenantId: 't', userId: 'u', web: tavily }, { url: 'https://example.com/a' });
  assert.equal(requests.at(-1).path, '/extract');
  assert.ok(out.length < 9_000);
  assert.match(out, /cut off/);

  const notALink = await findTool('read_web_page')!.run({ store: null as never, tenantId: 't', userId: 'u', web: tavily }, { url: 'file:///etc/passwd' });
  assert.match(notALink, /full link/);
});

test('service errors become plain messages', async () => {
  replies.push({ status: 432, body: {} });
  await assert.rejects(tavily.search('q'), /monthly web search allowance/);
  replies.push({ status: 200, body: { results: [], failed_results: [{ url: 'https://x.test', error: 'blocked' }] } });
  await assert.rejects(tavily.read('https://x.test'), /could not be read: blocked/);
});

test('the web tools are offered only when the server has a web search service', async () => {
  const store = await Store.open(':memory:');
  const { user } = await store.createTenantWithAdmin({ companyName: 'Acme', email: 'a@a.test', name: 'Ann', passwordHash: 'x' });
  const without = new MockBrain([{ text: 'ok', toolCalls: [] }]);
  await runAgent({ brain: without, store, user, companyName: 'Acme', history: [], question: 'hi' });
  assert.ok(!without.requests[0].tools.some((t) => t.name === 'web_search'));
  assert.doesNotMatch(without.requests[0].system, /live web/);

  const web: WebSearcher = { name: 'fake', search: async () => [{ title: 'T', url: 'https://t.test', content: 'Fresh fact.' }], read: async () => '' };
  const brain = new MockBrain();
  const result = await runAgent({ brain, store, web, user, companyName: 'Acme', history: [], question: 'what is in the news today?' });
  assert.deepEqual(result.toolsUsed, ['web_search']);
  assert.match(result.reply, /Fresh fact\./);
  assert.match(brain.requests[0].system, /live web/);

  // Asked for anyway without a service: refused and logged, never run.
  const sneaky = new MockBrain([{ text: '', toolCalls: [{ id: 'c', name: 'web_search', arguments: { query: 'x' } }] }, { text: 'done', toolCalls: [] }]);
  await runAgent({ brain: sneaky, store, user, companyName: 'Acme', history: [], question: 'q' });
  assert.ok((await store.getAudit(user.tenantId)).some((e) => e.event === 'tool_denied' && e.detail.reason === 'not set up on this server'));
});

test('an admin can turn web search off for their company', async () => {
  const store = await Store.open(':memory:');
  const { user } = await store.createTenantWithAdmin({ companyName: 'Acme', email: 'a@a.test', name: 'Ann', passwordHash: 'x' });
  await store.setToolEnabled(user.tenantId, 'web_search', false);
  const web: WebSearcher = { name: 'fake', search: async () => [], read: async () => '' };
  const brain = new MockBrain([{ text: 'ok', toolCalls: [] }]);
  await runAgent({ brain, store, web, user, companyName: 'Acme', history: [], question: 'news?' });
  const offered = brain.requests[0].tools.map((t) => t.name);
  assert.ok(!offered.includes('web_search'));
  assert.ok(offered.includes('read_web_page'), 'each web tool is switched separately');
});

test('the agent is told today’s date', () => {
  assert.match(systemPrompt('Acme', 'Ann', { now: new Date('2026-10-22T12:00:00Z') }), /Today is Thursday, October 22, 2026/);
});
