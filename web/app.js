// The browser app: sign-in, chat with voice, documents, and the admin page.
// Plain JavaScript with no build step. Everything shown is set with
// textContent, never innerHTML, so text from the AI or a document cannot
// inject markup into the page.

import { mountJarvis } from './jarvis.js';

const $ = (selector) => document.querySelector(selector);

let me = null;
let conversationId = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showError(where, err) {
  $(where).textContent = err ? err.message || String(err) : '';
}

// ── Sign-in ───────────────────────────────────────────────────────────────

async function boot() {
  try {
    me = await api('/api/me');
    showApp();
  } catch {
    $('#auth-view').hidden = false;
    $('#app-view').hidden = true;
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: formData(e.target) });
    showError('#auth-error');
    await boot();
  } catch (err) {
    showError('#auth-error', err);
  }
});

$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/signup', { method: 'POST', body: formData(e.target) });
    showError('#auth-error');
    await boot();
  } catch (err) {
    showError('#auth-error', err);
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} });
  location.reload();
});

async function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#company-name').textContent = me.companyName;
  $('#user-name').textContent = me.name;
  $('#brain-name').textContent = me.brain;
  for (const el of document.querySelectorAll('.admin-only')) el.hidden = me.role !== 'admin';
  await loadHistory();
}

async function loadHistory() {
  const history = await api('/api/history');
  conversationId = history.conversationId;
  $('#messages').replaceChildren();
  for (const m of history.messages) addMessage(m.role, m.content);
}

// ── Tabs ──────────────────────────────────────────────────────────────────

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== `tab-${tab.dataset.tab}`;
    showError('#app-error');
    if (tab.dataset.tab === 'jarvis') jarvis.show(me.companyName);
    else jarvis.hide();
    // Jarvis adds to the same conversation, so Chat re-reads it.
    if (tab.dataset.tab === 'chat') loadHistory().catch((err) => showError('#app-error', err));
    if (tab.dataset.tab === 'documents') loadDocuments();
    if (tab.dataset.tab === 'admin') loadAdmin();
  });
}

// ── Jarvis (web/jarvis.js), sharing the Chat tab's conversation ───────────

const jarvis = mountJarvis({
  root: $('#tab-jarvis'),
  api,
  getConversationId: () => conversationId,
  setConversationId: (id) => (conversationId = id),
});

// ── Chat ──────────────────────────────────────────────────────────────────

function addMessage(role, text, meta) {
  const el = document.createElement('div');
  el.className = `message ${role}`;
  el.textContent = text;
  if (meta) {
    const small = document.createElement('small');
    small.textContent = meta;
    el.append(small);
  }
  $('#messages').append(el);
  el.scrollIntoView({ block: 'end' });
  return el;
}

async function send(question) {
  if (!question.trim()) return;
  addMessage('user', question);
  const thinking = addMessage('assistant pending', 'Thinking…');
  try {
    const result = await api('/api/chat', { method: 'POST', body: { message: question, conversationId } });
    conversationId = result.conversationId;
    thinking.remove();
    addMessage('assistant', result.reply, result.toolsUsed.length ? `used: ${result.toolsUsed.join(', ')}` : '');
    if ($('#speak-replies').checked) speak(result.reply);
  } catch (err) {
    thinking.remove();
    addMessage('assistant error', err.message);
  }
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const question = input.value;
  input.value = '';
  send(question);
});

$('#new-chat').addEventListener('click', async () => {
  const result = await api('/api/conversations', { method: 'POST', body: {} });
  conversationId = result.conversationId;
  $('#messages').replaceChildren();
});

// ── Voice (the browser's own speech; Chrome and Edge) ─────────────────────

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let listening = null;

$('#mic').addEventListener('click', () => {
  if (!Recognition) {
    showError('#app-error', new Error('Voice input needs Chrome or Edge.'));
    return;
  }
  if (listening) {
    listening.stop();
    return;
  }
  const rec = new Recognition();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = false;
  rec.onresult = (event) => send(event.results[0][0].transcript);
  rec.onerror = (event) => showError('#app-error', new Error(`Voice input stopped: ${event.error}`));
  rec.onend = () => {
    listening = null;
    $('#mic').classList.remove('on');
  };
  listening = rec;
  $('#mic').classList.add('on');
  rec.start();
});

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// ── Documents ─────────────────────────────────────────────────────────────

async function loadDocuments() {
  $('#search-mode').textContent =
    me.search === 'meaning'
      ? 'Search finds passages by meaning as well as by matching words.'
      : 'Search finds passages by matching words.';
  try {
    const { documents } = await api('/api/documents');
    const list = $('#document-list');
    list.replaceChildren();
    if (documents.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No documents yet.';
      list.append(li);
    }
    for (const doc of documents) {
      const li = document.createElement('li');
      li.textContent = `${doc.title} · ${doc.length.toLocaleString()} characters `;
      if (me.role === 'admin') {
        const remove = document.createElement('button');
        remove.className = 'link';
        remove.textContent = 'Remove';
        remove.addEventListener('click', async () => {
          await api(`/api/documents?id=${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
          loadDocuments();
        });
        li.append(remove);
      }
      list.append(li);
    }
  } catch (err) {
    showError('#app-error', err);
  }
}

const MAX_UPLOAD_BYTES = 10_000_000;

/** The file's bytes as base64, without the "data:…;base64," prefix. */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const files = [...form.elements.file.files];
  if (files.length === 0) return;
  const status = $('#upload-status');
  const button = form.querySelector('button');
  showError('#app-error');
  const tooBig = files.filter((f) => f.size > MAX_UPLOAD_BYTES).map((f) => f.name);
  if (tooBig.length) {
    showError('#app-error', new Error(`Files must be at most 10 MB: ${tooBig.join(', ')}`));
    return;
  }
  // The title box names a single file; with several, each keeps its file name.
  const title = files.length === 1 ? form.elements.title.value : '';
  const added = [];
  const failed = [];
  let keywordsOnly = false;
  button.disabled = true;
  // One at a time, so a large batch never overloads the server.
  for (const [i, file] of files.entries()) {
    status.textContent = `Reading and indexing ${files.length > 1 ? `${i + 1} of ${files.length}: ` : ''}${file.name}…`;
    try {
      const result = await api('/api/documents/upload', {
        method: 'POST',
        body: { filename: file.name, title, data: await readAsBase64(file) },
      });
      added.push(`"${result.title}" (${result.chars.toLocaleString()} characters)`);
      if (me.search === 'meaning' && result.searchableBy !== 'meaning') keywordsOnly = true;
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
    }
  }
  button.disabled = false;
  status.textContent = added.length ? `Added ${added.join(', ')}.` : '';
  if (keywordsOnly) status.textContent += ' Search by meaning is unavailable right now, so they are searchable by words for the moment.';
  if (failed.length) showError('#app-error', new Error(`Not added: ${failed.join('; ')}`));
  if (added.length) form.reset();
  loadDocuments();
});

$('#document-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/documents', { method: 'POST', body: formData(e.target) });
    e.target.reset();
    loadDocuments();
  } catch (err) {
    showError('#app-error', err);
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function renderTools(tools) {
  const body = $('#tool-table tbody');
  body.replaceChildren();
  for (const tool of tools) {
    const tr = document.createElement('tr');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = tool.enabled;
    toggle.setAttribute('aria-label', `Turn ${tool.name} on or off`);
    toggle.addEventListener('change', async () => {
      try {
        renderTools((await api('/api/admin/tools', { method: 'PUT', body: { name: tool.name, enabled: toggle.checked } })).tools);
      } catch (err) {
        showError('#app-error', err);
      }
    });
    const on = document.createElement('td');
    on.append(toggle);
    tr.append(cell(tool.name), cell(tool.kind), cell(tool.description), on);
    body.append(tr);
  }
}

async function loadAdmin() {
  try {
    renderTools((await api('/api/admin/tools')).tools);
    const { entries } = await api('/api/admin/audit');
    const body = $('#audit-table tbody');
    body.replaceChildren();
    for (const entry of entries) {
      const tr = document.createElement('tr');
      tr.append(cell(new Date(entry.at).toLocaleString()), cell(entry.event), cell(JSON.stringify(entry.detail)));
      body.append(tr);
    }
  } catch (err) {
    showError('#app-error', err);
  }
}

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/users', { method: 'POST', body: formData(e.target) });
    e.target.reset();
    showError('#app-error');
    loadAdmin();
  } catch (err) {
    showError('#app-error', err);
  }
});

boot();
