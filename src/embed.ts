/**
 * Search by meaning: turns text into embeddings (lists of numbers whose
 * closeness tracks closeness of meaning), so "time off" finds a passage about
 * "vacation days" even though no word matches.
 *
 * Embeddings come from Ollama (`nomic-embed-text` by default; pull it with
 * `ollama pull nomic-embed-text`). Claude has no embeddings endpoint, so a
 * Claude setup can still point EMBEDDINGS at a local Ollama, or leave it off
 * and keep keyword search. Nothing here is required: when embeddings are off
 * or fail, search falls back to keywords (see Store.searchDocuments).
 */

import type { Config } from './config.ts';
import type { Store } from './store.ts';

export interface Embedder {
  /** Identifies the vectors; vectors from different models are never compared. */
  readonly model: string;
  /** One vector per text. `kind` lets models that want it mark questions apart from passages. */
  embed(texts: string[], kind: 'query' | 'document'): Promise<Float32Array[]>;
}

const TIMEOUT_MS = 60_000;

export class OllamaEmbedder implements Embedder {
  readonly model: string;

  constructor(
    private readonly baseUrl: string,
    private readonly modelName: string,
  ) {
    this.model = `ollama:${modelName}`;
  }

  async embed(texts: string[], kind: 'query' | 'document'): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    // nomic-embed-text is trained with these prefixes and ranks better with them.
    const prefix = this.modelName.startsWith('nomic-embed') ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.modelName, input: texts.map((t) => prefix + t) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error(`Could not reach Ollama at ${this.baseUrl} for embeddings.`);
    }
    if (!res.ok) {
      const detail = await res.text();
      if (res.status === 404) throw new Error(`Ollama has no model "${this.modelName}". Run \`ollama pull ${this.modelName}\`.`);
      throw new Error(`Ollama embeddings returned ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
      throw new Error('Ollama returned the wrong number of embeddings.');
    }
    return body.embeddings.map((v) => Float32Array.from(v));
  }
}

export function createEmbedder(config: Config): Embedder | undefined {
  return config.embeddings === 'ollama' ? new OllamaEmbedder(config.ollamaUrl, config.ollamaEmbedModel) : undefined;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const BATCH = 32;

/**
 * Embeds every passage of one company that has no vector from this model yet.
 * Returns how many it embedded. Throws if the embedder fails; passages
 * embedded before the failure keep their vectors.
 */
export async function embedPending(store: Store, embedder: Embedder, tenantId: string): Promise<number> {
  let done = 0;
  for (;;) {
    const chunks = await store.chunksToEmbed(tenantId, embedder.model, BATCH);
    if (chunks.length === 0) return done;
    // The title travels with each passage, so a short paragraph keeps its context.
    const vectors = await embedder.embed(
      chunks.map((c) => `${c.title}\n${c.text}`),
      'document',
    );
    for (const [i, c] of chunks.entries()) await store.setChunkEmbedding(tenantId, c.id, embedder.model, vectors[i]);
    done += chunks.length;
  }
}

/** Embeds what is missing for every company, for example documents added before embeddings were turned on. */
export async function embedAllPending(store: Store, embedder: Embedder): Promise<number> {
  let done = 0;
  for (const tenantId of await store.tenantIds()) done += await embedPending(store, embedder, tenantId);
  return done;
}
