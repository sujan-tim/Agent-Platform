/**
 * Every setting the server reads, in one place.
 *
 * Settings come from environment variables (or a `.env` file, which
 * `npm run dev` loads). Nothing secret has a default: a missing
 * SESSION_SECRET gets a random one per run, which is fine on a laptop and
 * refused in production.
 */

import { randomBytes } from 'node:crypto';

export type ProviderName = 'ollama' | 'mock' | 'anthropic';

export interface Config {
  port: number;
  dbPath: string;
  production: boolean;
  sessionSecret: string;
  allowSignup: boolean;
  provider: ProviderName;
  ollamaUrl: string;
  ollamaModel: string;
  anthropicModel: string;
}

const PROVIDERS: ProviderName[] = ['ollama', 'mock', 'anthropic'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';

  const provider = (env.AI_PROVIDER ?? 'ollama') as ProviderName;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`AI_PROVIDER must be one of ${PROVIDERS.join(', ')}; got "${provider}".`);
  }

  let sessionSecret = env.SESSION_SECRET ?? '';
  if (!sessionSecret) {
    if (production) throw new Error('SESSION_SECRET must be set in production.');
    // A fresh secret per run: sign-ins reset when the server restarts.
    sessionSecret = randomBytes(32).toString('hex');
  }

  return {
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? 'data/agent-platform.db',
    production,
    sessionSecret,
    allowSignup: env.ALLOW_SIGNUP !== 'false',
    provider,
    ollamaUrl: env.OLLAMA_URL ?? 'http://localhost:11434',
    ollamaModel: env.OLLAMA_MODEL ?? 'llama3.1',
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
  };
}
