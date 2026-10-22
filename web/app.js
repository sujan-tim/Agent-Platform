// The browser app: sign-in, chat with voice, documents, and the admin page.
// Plain JavaScript with no build step. Everything shown is set with
// textContent, never innerHTML, so text from the AI or a document cannot
// inject markup into the page.

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
    if (tab.dataset.tab === 'documents') loadDocuments();
    if (tab.dataset.tab === 'admin') loadAdmin();
  });
}

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

$('#document-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = $('#document-form');
  form.elements.text.value = await file.text();
  if (!form.elements.title.value) form.elements.title.value = file.name.replace(/\.[^.]+$/, '');
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
