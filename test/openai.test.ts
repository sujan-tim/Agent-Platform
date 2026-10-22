import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { OpenAICompatibleBrain, toOpenAI } from '../src/brain/openai.ts';

/** A stand-in for Groq: answers each request with the next scripted response. */
const responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = [];
const received: any[] = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ auth: req.headers.authorization, path: req.url, body: JSON.parse(body) });
    const next = responses.shift()!;
    res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers });
    res.end(JSON.stringify(next.body));
  });
});
let brain: OpenAICompatibleBrain;

before(async () => {
  await new Promise<void>((resolve) => fake.listen(0, resolve));
  brain = new OpenAICompatibleBrain('groq', `http://localhost:${(fake.address() as AddressInfo).port}/v1`, 'test-key', 'some-model');
});
after(() => {
  fake.close();
});

const tool = { name: 'search_documents', description: 'Search.', parameters: { type: 'object' as const, properties: {} } };

test('sends the conversation and tools, and reads tool calls back', async () => {
  responses.push({
    status: 200,
    body: {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_documents', arguments: '{"query":"leave"}' } }] },
        },
      ],
    },
  });
  const reply = await brain.respond({ system: 'Be brief.', messages: [{ role: 'user', content: 'Leave?' }], tools: [tool] });

  assert.deepEqual(reply.toolCalls, [{ id: 'c1', name: 'search_documents', arguments: { query: 'leave' } }]);
  const sent = received.at(-1);
  assert.equal(sent.auth, 'Bearer test-key');
  assert.equal(sent.path, '/v1/chat/completions');
  assert.equal(sent.body.model, 'some-model');
  assert.deepEqual(sent.body.messages[0], { role: 'system', content: 'Be brief.' });
  assert.equal(sent.body.tools[0].function.name, 'search_documents');
});

test('a reply cut off at the length limit never runs its tool call', async () => {
  responses.push({
    status: 200,
    body: { choices: [{ finish_reason: 'length', message: { content: 'Let me', tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{"q' } }] } }] },
  });
  const reply = await brain.respond({ system: '', messages: [{ role: 'user', content: 'q' }], tools: [tool] });
  assert.deepEqual(reply.toolCalls, []);
});

test('rate limits and bad keys become messages a person can act on', async () => {
  responses.push({ status: 429, body: { error: { message: 'Rate limit reached' } }, headers: { 'retry-after': '12' } });
  await assert.rejects(brain.respond({ system: '', messages: [{ role: 'user', content: 'q' }], tools: [] }), /free limit.*12 seconds/);
  responses.push({ status: 401, body: { error: { message: 'Invalid API Key' } } });
  await assert.rejects(brain.respond({ system: '', messages: [{ role: 'user', content: 'q' }], tools: [] }), /rejected the API key/);
  responses.push({ status: 404, body: { error: { message: 'The model `some-model` does not exist or you do not have access to it.' } } });
  await assert.rejects(brain.respond({ system: '', messages: [{ role: 'user', content: 'q' }], tools: [] }), /no model "some-model".*GROQ_MODEL/);
});

test('history: tool calls and their results map to the OpenAI format', () => {
  assert.deepEqual(
    toOpenAI([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', arguments: { x: 1 } }] },
      { role: 'tool', toolCallId: 't1', name: 'a', content: 'r1' },
      { role: 'assistant', content: 'done' },
    ]),
    [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'r1' },
      { role: 'assistant', content: 'done' },
    ],
  );
});
