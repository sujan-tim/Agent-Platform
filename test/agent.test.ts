import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_STEPS, runAgent } from '../src/agent.ts';
import { toAnthropic } from '../src/brain/anthropic.ts';
import { MockBrain } from '../src/brain/mock.ts';
import { Store } from '../src/store.ts';

function setup() {
  const store = new Store(':memory:');
  const { user } = store.createTenantWithAdmin({ companyName: 'Acme', email: 'ann@acme.test', name: 'Ann', passwordHash: 'x' });
  return { store, user };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  text: '',
  toolCalls: [{ id: `call-${name}`, name, arguments: args }],
});

test('the agent searches documents and answers from them', async () => {
  const { store, user } = setup();
  store.addDocument(user.tenantId, 'Leave policy', 'Staff get 25 vacation days.');
  const brain = new MockBrain([call('search_documents', { query: 'vacation days' }), { text: 'You get 25 days.', toolCalls: [] }]);

  const result = await runAgent({ brain, store, user, companyName: 'Acme', history: [], question: 'How much vacation?' });

  assert.equal(result.reply, 'You get 25 days.');
  assert.deepEqual(result.toolsUsed, ['search_documents']);
  const toolMessage = brain.requests[1].messages.at(-1);
  assert.equal(toolMessage?.role, 'tool');
  assert.match(toolMessage.role === 'tool' ? toolMessage.content : '', /<document title="Leave policy">/);
});

test('write tools are off by default: not offered, and refused if asked for anyway', async () => {
  const { store, user } = setup();
  const brain = new MockBrain([call('save_note', { text: 'remember this' }), { text: 'I could not save it.', toolCalls: [] }]);

  const result = await runAgent({ brain, store, user, companyName: 'Acme', history: [], question: 'Save a note' });

  const offered = brain.requests[0].tools.map((t) => t.name);
  assert.ok(!offered.includes('save_note'), 'a disabled tool is not offered to the brain');
  assert.deepEqual(result.toolsUsed, []);
  assert.deepEqual(store.listNotes(user.tenantId, user.id), [], 'nothing was written');
  assert.equal(store.getAudit(user.tenantId).find((e) => e.event === 'tool_denied')?.detail.tool, 'save_note');
});

test('an admin can turn a write tool on', async () => {
  const { store, user } = setup();
  store.setToolEnabled(user.tenantId, 'save_note', true);
  const brain = new MockBrain([call('save_note', { text: 'Call the supplier' }), { text: 'Saved.', toolCalls: [] }]);

  await runAgent({ brain, store, user, companyName: 'Acme', history: [], question: 'Note: call the supplier' });

  assert.equal(store.listNotes(user.tenantId, user.id)[0]?.text, 'Call the supplier');
});

test('an admin can turn a read tool off', async () => {
  const { store, user } = setup();
  store.setToolEnabled(user.tenantId, 'search_documents', false);
  const brain = new MockBrain([{ text: 'ok', toolCalls: [] }]);
  await runAgent({ brain, store, user, companyName: 'Acme', history: [], question: 'hi' });
  assert.ok(!brain.requests[0].tools.some((t) => t.name === 'search_documents'));
});

test('unknown tools are refused and logged', async () => {
  const { store, user } = setup();
  const brain = new MockBrain([call('delete_everything'), { text: 'Done.', toolCalls: [] }]);
  await runAgent({ brain, store, user, companyName: 'Acme', history: [], question: 'x' });
  assert.equal(store.getAudit(user.tenantId).find((e) => e.event === 'tool_denied')?.detail.tool, 'delete_everything');
});

test('the loop stops after MAX_STEPS brain calls', async () => {
  const { store, user } = setup();
  const brain = new MockBrain(Array.from({ length: MAX_STEPS }, () => call('get_current_time')));
  const result = await runAgent({ brain, store, user, companyName: 'Acme', history: [], question: 'loop' });
  assert.equal(brain.requests.length, MAX_STEPS);
  assert.match(result.reply, /could not finish/);
});

test('a refusal ends the turn without running tools', async () => {
  const { store, user } = setup();
  const brain = new MockBrain([{ text: 'I can’t help with that.', toolCalls: [], refused: true }]);
  const result = await runAgent({ brain, store, user, companyName: 'Acme', history: [], question: 'x' });
  assert.equal(result.reply, 'I can’t help with that.');
  assert.ok(store.getAudit(user.tenantId).some((e) => e.event === 'refused'));
});

test('every step is written to the audit log', async () => {
  const { store, user } = setup();
  const brain = new MockBrain([call('get_current_time'), { text: 'It is noon.', toolCalls: [] }]);
  await runAgent({ brain, store, user, companyName: 'Acme', history: [], question: 'What time is it?' });
  const events = store.getAudit(user.tenantId).map((e) => e.event).reverse();
  assert.deepEqual(events, ['question', 'tool_call', 'answer']);
});

test('Claude history: tool results share one user turn, and raw assistant turns pass through unchanged', () => {
  const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'a', input: {} }];
  const messages = toAnthropic([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', arguments: {} }], raw },
    { role: 'tool', toolCallId: 't1', name: 'a', content: 'r1' },
    { role: 'tool', toolCallId: 't2', name: 'b', content: 'r2' },
  ]);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].content, raw);
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
      { type: 'tool_result', tool_use_id: 't2', content: 'r2' },
    ],
  });
});
