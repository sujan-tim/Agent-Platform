/**
 * Every setting the server reads, in one place.
 *
 * Settings come from environment variables (or a `.env` file, which
 * `npm run dev` loads). Nothing secret has a default: a missing
 * SESSION_SECRET gets a random one per run, which is fine on a laptop and
 * refused in production.
 */

import { randomBytes } from 'node:crypto';

export type ProviderName = 'ollama' | 'mock' | 'anthropic' | 'groq';
/** Whose word to take for the visitor's address: nobody's, a proxy on this machine's, or any proxy's. */
export type TrustProxy = 'off' | 'local' | 'all';
export type EmbeddingsName = 'ollama' | 'off';

export interface Config {
  port: number;
  /** A postgres:// URL (hosted), or a folder for PGlite (on a laptop). */
  database: string;
  production: boolean;
  sessionSecret: string;
  allowSignup: boolean;
  trustProxy: TrustProxy;
  provider: ProviderName;
  ollamaUrl: string;
  ollamaModel: string;
  anthropicModel: string;
  groqModel: string;
  embeddings: EmbeddingsName;
  ollamaEmbedModel: string;
}

const PROVIDERS: ProviderName[] = ['ollama', 'mock', 'anthropic', 'groq'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';

  const provider = (env.AI_PROVIDER ?? 'ollama') as ProviderName;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`AI_PROVIDER must be one of ${PROVIDERS.join(', ')}; got "${provider}".`);
  }

  // Search by meaning is on by default with the Ollama brain, which already needs Ollama running.
  const embeddings = (env.EMBEDDINGS ?? (provider === 'ollama' ? 'ollama' : 'off')) as EmbeddingsName;
  if (embeddings !== 'ollama' && embeddings !== 'off') {
    throw new Error(`EMBEDDINGS must be ollama or off; got "${embeddings}".`);
  }

  let sessionSecret = env.SESSION_SECRET ?? '';
  if (!sessionSecret) {
    if (production) throw new Error('SESSION_SECRET must be set in production.');
    // A fresh secret per run: sign-ins reset when the server restarts.
    sessionSecret = randomBytes(32).toString('hex');
  }

  return {
    port: Number(env.PORT ?? 3000),
    database: env.DATABASE_URL ?? 'data/pglite',
    production,
    sessionSecret,
    // Off unless asked for: a company's platform is private by default, and people join by
    // being added by an admin or by an access request an admin approves.
    allowSignup: env.ALLOW_SIGNUP === 'true',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    provider,
    ollamaUrl: env.OLLAMA_URL ?? 'http://localhost:11434',
    ollamaModel: env.OLLAMA_MODEL ?? 'llama3.1',
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
    groqModel: env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
    embeddings,
    ollamaEmbedModel: env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
  };
}

/**
 * TRUST_PROXY: `local` (or `true`) for a proxy on this machine, such as a
 * Cloudflare Tunnel; `all` for a host whose proxy is the only way in, such as
 * Render. Anything else trusts no proxy header.
 */
function parseTrustProxy(value: string | undefined): TrustProxy {
  if (value === 'all') return 'all';
  if (value === 'local' || value === 'true') return 'local';
  return 'off';
}
