/**
 * The one interface every AI brain implements.
 *
 * The agent loop speaks only this shape, so swapping Ollama for Claude (or the
 * test mock) never touches the loop, the tools or the storage. Each brain
 * translates to and from its own wire format.
 */

/** A tool the brain may ask to call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      /**
       * The brain's own record of this turn, handed back to the same brain on
       * the next step of the loop. Claude needs its exact content blocks
       * (including thinking) returned unchanged; other brains ignore it.
       */
      raw?: unknown;
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface BrainRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface BrainReply {
  /** What the brain said this step (may be empty when it only calls tools). */
  text: string;
  toolCalls: ToolCall[];
  /** True when the brain declined to answer (for example a safety refusal). */
  refused?: boolean;
  raw?: unknown;
}

export interface Brain {
  readonly name: string;
  respond(request: BrainRequest): Promise<BrainReply>;
}
