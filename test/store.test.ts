import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store } from '../src/store.ts';

function twoCompanies() {
  const store = new Store(':memory:');
  const a = store.createTenantWithAdmin({ companyName: 'Acme', email: 'ann@acme.test', name: 'Ann', passwordHash: 'x' });
  const b = store.createTenantWithAdmin({ companyName: 'Bolt', email: 'bob@bolt.test', name: 'Bob', passwordHash: 'x' });
  return { store, a, b };
}

test('one company never sees another company’s documents', () => {
  const { store, a, b } = twoCompanies();
  const doc = store.addDocument(a.tenant.id, 'Acme leave policy', 'Acme staff get 25 vacation days.');

  assert.equal(store.listDocuments(a.tenant.id).length, 1);
  assert.equal(store.listDocuments(b.tenant.id).length, 0);
  assert.deepEqual(store.searchDocuments(b.tenant.id, 'vacation days'), []);
  assert.equal(store.deleteDocument(b.tenant.id, doc.id), false, 'another company cannot delete it');
  assert.equal(store.listDocuments(a.tenant.id).length, 1);
});

test('conversations, notes and audit entries stay with their company', () => {
  const { store, a, b } = twoCompanies();
  const conversation = store.createConversation(a.tenant.id, a.user.id);
  store.addMessage(a.tenant.id, conversation, 'user', 'secret plan');
  store.addNote(a.tenant.id, a.user.id, 'Acme note');
  store.audit(a.tenant.id, a.user.id, 'question', { text: 'secret plan' });

  assert.equal(store.ownsConversation(b.tenant.id, b.user.id, conversation), false);
  assert.deepEqual(store.getMessages(b.tenant.id, conversation), []);
  assert.deepEqual(store.listNotes(b.tenant.id, a.user.id), []);
  assert.equal(store.getAudit(b.tenant.id).length, 0);
  assert.equal(store.getUser(b.tenant.id, a.user.id), undefined, 'a user id from another company resolves to nobody');
});

test('tool settings are per company', () => {
  const { store, a, b } = twoCompanies();
  store.setToolEnabled(a.tenant.id, 'save_note', true);
  assert.equal(store.getToolSettings(a.tenant.id).get('save_note'), true);
  assert.equal(store.getToolSettings(b.tenant.id).has('save_note'), false);
});

test('document search ranks the paragraph with the most matching words first', () => {
  const { store, a } = twoCompanies();
  store.addDocument(a.tenant.id, 'Handbook', 'Parking is free.\n\nVacation days: 25 per year.\n\nVacation requests go to your manager.');
  const hits = store.searchDocuments(a.tenant.id, 'how many vacation days per year');
  assert.equal(hits[0].excerpt, 'Vacation days: 25 per year.');
  assert.equal(hits[0].title, 'Handbook');
});

test('emails are unique across all companies, ignoring case', () => {
  const { store, a } = twoCompanies();
  assert.throws(() => store.addUser(a.tenant.id, { email: 'BOB@bolt.test', name: 'Imposter', role: 'member', passwordHash: 'x' }));
});
