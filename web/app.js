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
  setUpDatabase();
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
    if (tab.dataset.tab === 'review') loadReview();
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
  company_db_overview: 'Looked at the company database',
  find_companies: 'Searched the company database',
  get_company: 'Looked up a company',
  company_totals: 'Added up the company database',
  find_duplicate_companies: 'Checked for duplicates',
  propose_company_update: 'Proposed changes for review',
  propose_new_company: 'Proposed a new company for review',
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
    if (result.toolsUsed.some((t) => t.startsWith('propose_'))) refreshReviewCount();
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

// ── Company database: suggestions and the Review tab ──────────────────────

const DATABASE_SUGGESTIONS = [
  'Which companies are missing a website?',
  'Total Net Sales by country',
  'Find duplicate companies in our database',
];

function setUpDatabase() {
  $('#review-tab').hidden = !me.database;
  if (me.database) {
    // Point the welcome screen at what the database makes possible.
    document.querySelectorAll('.suggestion').forEach((button, i) => (button.textContent = DATABASE_SUGGESTIONS[i] ?? button.textContent));
    refreshReviewCount();
  }
}

async function refreshReviewCount() {
  if (!me.database) return;
  try {
    const { changes } = await api('/api/sheet/changes');
    $('#review-count').textContent = changes.length;
    $('#review-count').hidden = changes.length === 0;
  } catch {
    // The count is a convenience; the Review tab shows any error.
  }
}

function describeValue(value) {
  return value === '' || value === null || value === undefined ? '(empty)' : value;
}

function renderChange(change, { selectable }) {
  const card = document.createElement('div');
  card.className = `change change-${change.status}`;

  const head = document.createElement('div');
  head.className = 'change-head';
  if (selectable) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'change-select';
    box.value = change.id;
    box.setAttribute('aria-label', `Select change to ${change.company}`);
    head.append(box);
  }
  const title = document.createElement('strong');
  title.textContent = change.kind === 'add' ? `Add ${change.company}` : change.company;
  head.append(title);
  if (change.kind === 'update') {
    const where = document.createElement('span');
    where.className = 'muted';
    where.textContent = ` · row ${change.row} · ${change.column}`;
    head.append(where);
  }
  card.append(head);

  if (change.kind === 'update') {
    const diff = document.createElement('div');
    diff.className = 'diff';
    const before = document.createElement('span');
    before.className = 'old';
    before.textContent = describeValue(change.oldValue);
    const after = document.createElement('span');
    after.className = 'new';
    after.textContent = describeValue(change.newValue);
    diff.append(before, ' → ', after);
    card.append(diff);
  } else {
    const fields = document.createElement('dl');
    fields.className = 'fields';
    for (const [column, value] of Object.entries(JSON.parse(change.newValue))) {
      const dt = document.createElement('dt');
      dt.textContent = column;
      const dd = document.createElement('dd');
      dd.textContent = value;
      fields.append(dt, dd);
    }
    card.append(fields);
  }

  const meta = document.createElement('div');
  meta.className = 'change-meta muted';
  const when = new Date(change.decidedAt ?? change.proposedAt).toLocaleString();
  meta.textContent =
    change.status === 'pending'
      ? `${change.reason} · proposed by ${change.proposedBy}, ${when}`
      : `${change.status === 'applied' ? 'Approved' : change.status === 'rejected' ? 'Rejected' : 'Could not apply'} by ${change.decidedBy ?? 'someone'}, ${when}${change.note ? ` · ${change.note}` : ''}`;
  card.append(meta);

  if (change.warning) {
    const warn = document.createElement('div');
    warn.className = 'change-warning';
    warn.textContent = `⚠ ${change.warning}`;
    card.append(warn);
  }
  if (change.sources.length) {
    const links = document.createElement('div');
    links.className = 'change-sources';
    for (const url of change.sources) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = hostOf(url);
      a.title = url;
      links.append(a);
    }
    card.append(links);
  }
  return card;
}

async function loadReview() {
  showError('#app-error');
  try {
    const [{ changes }, { changes: history }] = await Promise.all([api('/api/sheet/changes'), api('/api/sheet/changes?status=all')]);
    const list = $('#change-list');
    list.replaceChildren();
    if (changes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'Nothing waiting. Ask the agent to update or add companies, and its proposals appear here.';
      list.append(empty);
    }
    for (const change of changes) list.append(renderChange(change, { selectable: me.role === 'admin' }));
    $('#select-all').checked = false;
    const historyList = $('#history-list');
    historyList.replaceChildren(...history.filter((c) => c.status !== 'pending').slice(0, 50).map((c) => renderChange(c, { selectable: false })));
    $('#review-count').textContent = changes.length;
    $('#review-count').hidden = changes.length === 0;
  } catch (err) {
    showError('#app-error', err);
  }
}

$('#select-all').addEventListener('change', (e) => {
  for (const box of document.querySelectorAll('.change-select')) box.checked = e.target.checked;
});

async function decide(decision) {
  const ids = [...document.querySelectorAll('.change-select:checked')].map((box) => Number(box.value));
  if (ids.length === 0) {
    showError('#app-error', new Error('Select the changes first.'));
    return;
  }
  const status = $('#review-status');
  status.textContent = decision === 'approve' ? 'Writing to the sheet…' : 'Rejecting…';
  for (const button of [$('#approve-selected'), $('#reject-selected')]) button.disabled = true;
  try {
    const result = await api('/api/sheet/changes/decide', { method: 'POST', body: { ids, decision } });
    status.textContent =
      decision === 'approve'
        ? `${result.applied} change${result.applied === 1 ? '' : 's'} written to the sheet.${result.failed.length ? ` ${result.failed.length} could not be applied (see Recent decisions).` : ''}`
        : `${result.rejected} rejected.`;
    await loadReview();
  } catch (err) {
    status.textContent = '';
    showError('#app-error', err);
  } finally {
    for (const button of [$('#approve-selected'), $('#reject-selected')]) button.disabled = false;
  }
}

$('#approve-selected').addEventListener('click', () => decide('approve'));
$('#reject-selected').addEventListener('click', () => decide('reject'));

// ── Admin: the company database connection ────────────────────────────────

async function loadSheetStatus() {
  const box = $('#sheet-status');
  box.replaceChildren();
  const line = (text, className = '') => {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    box.append(p);
    return p;
  };
  const status = await api('/api/sheet');
  $('#sheet-form').hidden = !status.configured || !!status.connection;
  if (!status.configured) {
    line('Not set up on this server. Add GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID to the server settings (see DEPLOY.md).', 'muted');
    return;
  }
  if (!status.connection) {
    line(`Share the Google Sheet with ${status.robotEmail} as Editor, then paste its link below.`, 'muted');
    return;
  }
  if (status.error) {
    line(`Connected to the "${status.connection.tab}" tab, but it cannot be read: ${status.error}`, 'error');
  } else {
    line(`✓ Connected to the "${status.connection.tab}" tab: ${status.rows} companies, ${status.columns.length} columns. ${status.pending} change${status.pending === 1 ? '' : 's'} waiting for review.`);
  }
  const disconnect = document.createElement('button');
  disconnect.type = 'button';
  disconnect.className = 'link';
  disconnect.textContent = 'Disconnect';
  disconnect.addEventListener('click', async () => {
    if (!confirm('Disconnect the company database? Changes waiting for review are discarded; the sheet itself is not touched.')) return;
    try {
      await api('/api/sheet', { method: 'DELETE' });
      me.database = false;
      setUpDatabase();
      loadSheetStatus();
    } catch (err) {
      showError('#app-error', err);
    }
  });
  box.append(disconnect);
}

$('#sheet-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/sheet/connect', { method: 'POST', body: formData(e.target) });
    e.target.reset();
    me.database = true;
    setUpDatabase();
    showError('#app-error');
    await loadSheetStatus();
  } catch (err) {
    showError('#app-error', err);
  } finally {
    button.disabled = false;
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
    await loadSheetStatus();
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
