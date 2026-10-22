import type { Config } from '../config.ts';
import { AnthropicBrain } from './anthropic.ts';
import { MockBrain } from './mock.ts';
import { OllamaBrain } from './ollama.ts';
import { OpenAICompatibleBrain } from './openai.ts';
import type { Brain } from './types.ts';

/** Picks the brain named by AI_PROVIDER. This is the only place that knows them all. */
export function createBrain(config: Config): Brain {
  switch (config.provider) {
    case 'ollama':
      return new OllamaBrain(config.ollamaUrl, config.ollamaModel);
    case 'mock':
      return new MockBrain();
    case 'anthropic':
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY to be set.');
      }
      return new AnthropicBrain(config.anthropicModel);
    case 'groq':
      if (!process.env.GROQ_API_KEY) {
        throw new Error('AI_PROVIDER=groq needs GROQ_API_KEY to be set. Create one at console.groq.com.');
      }
      return new OpenAICompatibleBrain('groq', 'https://api.groq.com/openai/v1', process.env.GROQ_API_KEY, config.groqModel);
  }
}

export type { Brain } from './types.ts';
