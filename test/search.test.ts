import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { cosine, type Embedder, embedPending } from '../src/embed.ts';
import { chunkText, Store } from '../src/store.ts';
import { findTool } from '../src/tools.ts';

/**
 * A stand-in for a real embedding model: one dimension per topic, and words
 * that mean the same thing count toward the same topic. Enough to show that
 * search finds a passage with none of the query's words.
 */
const TOPICS = [
  ['vacation', 'holiday', 'leave', 'time off', 'pto'],
  ['expense', 'receipt', 'reimburse', 'refund', 'money back'],
  ['laptop', 'computer', 'hardware', 'equipment'],
];

class TopicEmbedder implements Embedder {
  readonly model = 'test:topics';
  calls = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    return texts.map((t) => Float32Array.from(TOPICS.map((words) => words.filter((w) => t.toLowerCase().includes(w)).length + 0.01)));
  }
}

class BrokenEmbedder implements Embedder {
  readonly model = 'test:broken';
  async embed(): Promise<Float32Array[]> {
    throw new Error('Ollama is not running');
  }
}

async function companyWithHandbook() {
  const store = await Store.open(':memory:');
  const { tenant, user } = await store.createTenantWithAdmin({ companyName: 'Acme', email: 'ann@acme.test', name: 'Ann', passwordHash: 'x' });
  await store.addDocument(
    tenant.id,
    'Handbook',
    'Staff get 25 vacation days a year.\n\nKeep every receipt; finance will reimburse within 10 days.\n\nNew starters receive a laptop on day one.',
  );
  return { store, tenantId: tenant.id, userId: user.id };
}

const search = (ctx: { store: Store; tenantId: string; userId: string; embedder?: Embedder }, query: string) =>
  findTool('search_documents')!.run(ctx, { query });

test('search by meaning finds a passage that shares no words with the question', async () => {
  const ctx = { ...(await companyWithHandbook()), embedder: new TopicEmbedder() };
  assert.equal(await embedPending(ctx.store, ctx.embedder, ctx.tenantId), 3);

  const withMeaning = await search(ctx, 'How do I get my money back for a taxi?');
  assert.match(withMeaning.split('</document>')[0], /reimburse/, 'the expenses passage comes first');

  const keywordsOnly = await search({ ...ctx, embedder: undefined }, 'How do I get my money back for a taxi?');
  assert.doesNotMatch(keywordsOnly, /reimburse/, 'keywords alone miss it');
});

test('an exact word still wins when it matches', async () => {
  const ctx = { ...(await companyWithHandbook()), embedder: new TopicEmbedder() };
  await embedPending(ctx.store, ctx.embedder, ctx.tenantId);
  const hits = await ctx.store.searchDocuments(ctx.tenantId, 'laptop', 3, {
    model: ctx.embedder.model,
    vector: (await ctx.embedder.embed(['laptop']))[0],
  });
  assert.match(hits[0].excerpt, /laptop/);
});

test('when the embedder fails, search falls back to keywords', async () => {
  const ctx = { ...(await companyWithHandbook()), embedder: new BrokenEmbedder() };
  await assert.rejects(embedPending(ctx.store, ctx.embedder, ctx.tenantId));
  const result = await search(ctx, 'vacation days');
  assert.match(result, /25 vacation days/);
});

test('vectors from another model are ignored, and embedding is not repeated', async () => {
  const ctx = { ...(await companyWithHandbook()), embedder: new TopicEmbedder() };
  await embedPending(ctx.store, ctx.embedder, ctx.tenantId);
  assert.equal(await embedPending(ctx.store, ctx.embedder, ctx.tenantId), 0, 'nothing left to embed');
  assert.deepEqual(await ctx.store.embeddingCoverage(ctx.tenantId, ctx.embedder.model), { embedded: 3, total: 3 });
  assert.deepEqual(await ctx.store.embeddingCoverage(ctx.tenantId, 'other:model'), { embedded: 0, total: 3 });

  // Asked with another model's vector, only keyword matches come back.
  const hits = await ctx.store.searchDocuments(ctx.tenantId, 'money back', 3, { model: 'other:model', vector: Float32Array.from([0, 1, 0]) });
  assert.deepEqual(hits, []);
});

test('search by meaning never crosses companies', async () => {
  const { store, tenantId } = await companyWithHandbook();
  const other = await store.createTenantWithAdmin({ companyName: 'Bolt', email: 'bob@bolt.test', name: 'Bob', passwordHash: 'x' });
  const embedder = new TopicEmbedder();
  await embedPending(store, embedder, tenantId);
  await embedPending(store, embedder, other.tenant.id);
  const vector = (await embedder.embed(['holiday']))[0];
  assert.deepEqual(await store.searchDocuments(other.tenant.id, 'holiday', 3, { model: embedder.model, vector }), []);
});

test('deleting a document removes its passages', async () => {
  const { store, tenantId } = await companyWithHandbook();
  const [doc] = await store.listDocuments(tenantId);
  assert.ok(await store.deleteDocument(tenantId, doc.id));
  assert.deepEqual(await store.embeddingCoverage(tenantId, 'any'), { embedded: 0, total: 0 });
  assert.deepEqual(await store.searchDocuments(tenantId, 'vacation'), []);
});

test('a database on disk keeps its data across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-platform-'));
  try {
    let store = await Store.open(dir);
    const { tenant } = await store.createTenantWithAdmin({ companyName: 'Acme', email: 'ann@acme.test', name: 'Ann', passwordHash: 'x' });
    await store.addDocument(tenant.id, 'Parking', 'Parking is free on weekends.');
    await store.close();

    store = await Store.open(dir);
    assert.equal((await store.findUserForLogin('ann@acme.test'))?.tenantId, tenant.id);
    assert.equal((await store.searchDocuments(tenant.id, 'parking'))[0]?.excerpt, 'Parking is free on weekends.');
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('long paragraphs are split near sentence ends; short ones stay whole', async () => {
  const sentence = 'This sentence is exactly fifty characters long ok. ';
  const chunks = chunkText(`Short one.\n\n${sentence.repeat(50)}`);
  assert.equal(chunks[0], 'Short one.');
  assert.ok(chunks.length > 3);
  for (const chunk of chunks.slice(1)) {
    assert.ok(chunk.length <= 1000);
    assert.ok(chunk.endsWith('.'), 'cut at a sentence end');
  }
  assert.equal(chunks.slice(1).join(' '), sentence.repeat(50).trim());
});

test('cosine similarity', async () => {
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0])), 1);
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 3])), 0);
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])), 0, 'different lengths never match');
});
