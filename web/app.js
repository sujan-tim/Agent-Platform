// The browser app: sign-in, chat with voice, documents, and the admin page.
// Plain JavaScript with no build step. Everything shown is set with
// textContent or built as DOM nodes (web/markdown.js), never innerHTML, so
// text from the AI, a document or a web page cannot inject markup.

import { mountJarvis } from './jarvis.js';
import { copyText, hostOf, markdownToSpeech, renderMarkdown } from './markdown.js';

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
  // Shows at a glance whether the agent can look things up live.
  $('#brain-name').textContent = `${me.brain} · web search ${me.web ? 'on' : 'off'}`;
  for (const el of document.querySelectorAll('.admin-only')) el.hidden = me.role !== 'admin';
  await loadConversations();
  const latest = conversations[0];
  if (latest) await openConversation(latest.id);
  else startNewChat();
}

// The chat fills the window below the top bar, whose height changes when it wraps on a phone.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--topbar-height', `${Math.ceil(entry.borderBoxSize[0].blockSize)}px`);
}).observe($('.topbar'));

// ── Tabs ──────────────────────────────────────────────────────────────────

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== `tab-${tab.dataset.tab}`;
    showError('#app-error');
    if (tab.dataset.tab === 'jarvis') jarvis.show(me.companyName);
    else jarvis.hide();
    // Jarvis adds to the same conversation, so Chat re-reads it.
    if (tab.dataset.tab === 'chat') refreshChat().catch((err) => showError('#app-error', err));
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

// ── Chat: the list of chats ───────────────────────────────────────────────

let conversations = [];

async function loadConversations() {
  conversations = (await api('/api/conversations')).conversations;
  renderConversationList();
}

function renderConversationList() {
  const list = $('#conversation-list');
  list.replaceChildren();
  if (conversations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted sidebar-empty';
    empty.textContent = 'No chats yet.';
    list.append(empty);
  }
  for (const c of conversations) {
    const row = document.createElement('div');
    row.className = `conversation${c.id === conversationId ? ' active' : ''}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'conversation-open';
    open.textContent = c.title;
    open.title = c.title;
    open.addEventListener('click', () => {
      openConversation(c.id).catch((err) => showError('#app-error', err));
      closeSidebar();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'conversation-delete';
    remove.setAttribute('aria-label', `Delete chat: ${c.title}`);
    remove.title = 'Delete chat';
    remove.textContent = '×';
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
      try {
        await api(`/api/conversation?id=${encodeURIComponent(c.id)}`, { method: 'DELETE' });
        if (c.id === conversationId) startNewChat();
        await loadConversations();
      } catch (err) {
        showError('#app-error', err);
      }
    });
    row.append(open, remove);
    list.append(row);
  }
}

async function openConversation(id) {
  const { messages } = await api(`/api/conversation?id=${encodeURIComponent(id)}`);
  conversationId = id;
  clearMessages();
  for (const m of messages) {
    if (m.role === 'user') addUserMessage(m.content);
    else addAssistantMessage(m.content, m.meta ?? {});
  }
  setChatTitle();
  renderConversationList();
  scrollToEnd();
}

function startNewChat() {
  // The server creates the conversation with its first message.
  conversationId = null;
  clearMessages();
  setChatTitle();
  renderConversationList();
  $('#chat-input').focus();
}

/** Re-reads the open chat, which Jarvis may have added to. */
async function refreshChat() {
  await loadConversations();
  if (conversationId) await openConversation(conversationId);
}

function setChatTitle() {
  $('#chat-title').textContent = conversations.find((c) => c.id === conversationId)?.title ?? 'New chat';
}

$('#new-chat').addEventListener('click', () => {
  startNewChat();
  closeSidebar();
});

// On narrow screens the list of chats slides over the chat.
$('#toggle-sidebar').addEventListener('click', () => {
  const open = !$('#tab-chat').classList.contains('sidebar-open');
  $('#tab-chat').classList.toggle('sidebar-open', open);
  $('#toggle-sidebar').setAttribute('aria-expanded', String(open));
});

function closeSidebar() {
  $('#tab-chat').classList.remove('sidebar-open');
  $('#toggle-sidebar').setAttribute('aria-expanded', 'false');
}

// ── Chat: messages ────────────────────────────────────────────────────────

const TOOL_LABELS = {
  web_search: 'Searched the web',
  read_web_page: 'Read a web page',
  search_documents: 'Searched company documents',
  save_note: 'Saved a note',
  get_current_time: 'Checked the time',
};

function clearMessages() {
  $('#messages').replaceChildren($('#empty-state'));
  $('#empty-state').hidden = false;
}

function scrollToEnd() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

function addUserMessage(text) {
  $('#empty-state').hidden = true;
  const row = document.createElement('div');
  row.className = 'msg msg-user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.append(bubble);
  $('#messages').append(row);
  scrollToEnd();
  return row;
}

/** An answer: formatted text, then what the agent did, its sources, and actions. */
function addAssistantMessage(text, { sources = [], toolsUsed = [] } = {}) {
  $('#empty-state').hidden = true;
  const row = document.createElement('div');
  row.className = 'msg msg-assistant';

  const steps = toolsUsed.map((t) => TOOL_LABELS[t]).filter(Boolean);
  if (steps.length) {
    const used = document.createElement('div');
    used.className = 'steps';
    used.textContent = steps.join(' · ');
    row.append(used);
  }

  row.append(renderMarkdown(text, { sources }));

  if (sources.length) {
    const list = document.createElement('div');
    list.className = 'sources';
    for (const source of sources) {
      const a = document.createElement('a');
      a.className = 'source';
      a.href = source.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = source.title;
      const n = document.createElement('span');
      n.className = 'source-n';
      n.textContent = source.n;
      const label = document.createElement('span');
      label.className = 'source-label';
      label.textContent = source.title === source.url ? hostOf(source.url) : source.title;
      const host = document.createElement('span');
      host.className = 'source-host';
      host.textContent = hostOf(source.url);
      a.append(n, label, host);
      list.append(a);
    }
    row.append(list);
  }

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'link';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => copyText(text, copy));
  const listen = document.createElement('button');
  listen.type = 'button';
  listen.className = 'link';
  listen.textContent = 'Read aloud';
  listen.addEventListener('click', () => speak(text));
  actions.append(copy, listen);
  row.append(actions);

  $('#messages').append(row);
  return row;
}

function addTypingIndicator() {
  const row = document.createElement('div');
  row.className = 'msg msg-assistant';
  const dots = document.createElement('div');
  dots.className = 'typing';
  dots.setAttribute('aria-label', 'The assistant is thinking');
  dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  row.append(dots);
  $('#messages').append(row);
  scrollToEnd();
  return row;
}

let sending = false;

async function send(question) {
  question = question.trim();
  if (!question || sending) return;
  sending = true;
  updateSendButton();
  addUserMessage(question);
  const typing = addTypingIndicator();
  try {
    const result = await api('/api/chat', { method: 'POST', body: { message: question, conversationId } });
    const isNew = conversationId !== result.conversationId;
    conversationId = result.conversationId;
    typing.remove();
    const answer = addAssistantMessage(result.reply, result);
    // Show the start of the answer, scrolling the chat only (never the whole page).
    const box = $('#messages');
    box.scrollTo({ top: answer.offsetTop - box.offsetTop - 16, behavior: 'smooth' });
    if ($('#speak-replies').checked) speak(result.reply);
    if (isNew) {
      await loadConversations();
      setChatTitle();
    }
  } catch (err) {
    typing.remove();
    const row = document.createElement('div');
    row.className = 'msg msg-assistant msg-error';
    row.textContent = err.message;
    $('#messages').append(row);
    scrollToEnd();
  } finally {
    sending = false;
    updateSendButton();
  }
}

// ── Chat: the message box ─────────────────────────────────────────────────

const input = $('#chat-input');

function updateSendButton() {
  $('#send').disabled = sending || !input.value.trim();
}

/** Grows with its text, up to a limit, like ChatGPT's box. */
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

input.addEventListener('input', () => {
  autoGrow();
  updateSendButton();
});

// Enter sends; Shift+Enter starts a new line. Not while an IME is composing.
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const question = input.value;
  if (!question.trim() || sending) return;
  input.value = '';
  autoGrow();
  updateSendButton();
  send(question);
});

for (const button of document.querySelectorAll('.suggestion')) {
  button.addEventListener('click', () => send(button.textContent));
}

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
  speechSynthesis.speak(new SpeechSynthesisUtterance(markdownToSpeech(text)));
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
    toggle.checked = tool.enabled && tool.available;
    // A tool this server cannot run (no web search service) cannot be switched on.
    toggle.disabled = !tool.available;
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
    if (!tool.available) {
      const note = document.createElement('small');
      note.className = 'muted';
      note.textContent = ' Not set up on this server (needs TAVILY_API_KEY).';
      on.append(note);
    }
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
