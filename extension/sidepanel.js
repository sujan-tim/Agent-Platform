// The side panel: sign-in, the chat, and the task loop.
//
// A task runs step by step. Each step the panel takes a text snapshot of the
// tab (page.js), sends the task so far to the server (/api/browser/step), and
// gets back either an answer or actions. Actions are carried out on the page
// one at a time; any that could send, submit, buy or delete something wait for
// the person to approve them in the panel, and password or card fields are
// never filled. Then the next step starts with a fresh snapshot, until the
// agent answers, the person presses Stop, or the step limit is reached.
//
// Everything shown is built as DOM nodes (markdown.js), never as HTML text.

import { hostOf, renderMarkdown } from './markdown.js';

const $ = (selector) => document.querySelector(selector);
const DEFAULT_SERVER = 'https://agent-platform-4qcw.onrender.com';
/** Page steps per task before the panel stops and hands back to the person. */
const MAX_STEPS = 25;
/** Messages sent per step; older ones are dropped from the start of the task. */
const MAX_MESSAGES = 60;
const RISKY_SITE = /bank|paypal|venmo|stripe|coinbase|chase|wellsfargo|citi|hsbc|barclays|schwab|fidelity|vanguard|robinhood|wise\.com|revolut/i;

let settings = { server: DEFAULT_SERVER, token: '', user: null };
let task = [];
let running = false;
let stopRequested = false;
let pendingApproval = null;
/** The active tab's site, kept current so a click can ask Chrome for it straight away. */
let currentOrigin = null;

// ── Storage and the server ────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get(['server', 'token', 'user']);
  settings = { server: stored.server || DEFAULT_SERVER, token: stored.token || '', user: stored.user || null };
}

async function saveSettings(values) {
  settings = { ...settings, ...values };
  await chrome.storage.local.set(settings);
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(settings.server + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(settings.token && { authorization: `Bearer ${settings.token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Could not reach ${hostOf(settings.server)}. If the server was asleep, try again in a minute.`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && settings.token) {
    await saveSettings({ token: '', user: null });
    showSignIn('Your sign-in expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ── Sign in and out ───────────────────────────────────────────────────────

function showSignIn(message = '') {
  $('#main-view').hidden = true;
  $('#signin-view').hidden = false;
  $('#signin-form').elements.server.value = settings.server;
  $('#signin-error').textContent = message;
}

function showMain() {
  $('#signin-view').hidden = true;
  $('#main-view').hidden = false;
  $('#who').textContent = `${settings.user.companyName} · ${settings.user.name}`;
  updateSiteBar();
  $('#input').focus();
}

$('#signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  $('#signin-error').textContent = '';
  let server;
  try {
    server = new URL(form.elements.server.value).origin;
  } catch {
    $('#signin-error').textContent = 'Enter the server address, e.g. https://your-app.onrender.com';
    return;
  }
  // The panel may only talk to the server once Chrome allows it; asked here, on the click.
  const allowed = await chrome.permissions.request({ origins: [`${server}/*`] });
  if (!allowed) {
    $('#signin-error').textContent = 'The extension needs permission to reach your server.';
    return;
  }
  await saveSettings({ server, token: '', user: null });
  try {
    const result = await api('/api/login', { email: form.elements.email.value, password: form.elements.password.value, client: 'extension' });
    const { token, ...user } = result;
    await saveSettings({ token, user });
    form.elements.password.value = '';
    showMain();
  } catch (err) {
    $('#signin-error').textContent = err.message;
  }
});

$('#sign-out').addEventListener('click', async () => {
  stopTask();
  await saveSettings({ token: '', user: null });
  newTask();
  showSignIn();
});

// ── The current tab and site permission ───────────────────────────────────

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

/** Pages Chrome never lets extensions touch. */
function scriptable(url) {
  const origin = originOf(url);
  return !!origin && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com)$/.test(origin);
}

function siteAllowed(origin) {
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

/** Asks Chrome to let the agent work on a site. Must be called from a click. */
async function allowSite(origin) {
  if (RISKY_SITE.test(origin) && !confirm(`${hostOf(origin)} looks like a banking or payment site. Let the agent read and act on it anyway?`)) {
    return false;
  }
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

async function updateSiteBar() {
  const tab = await activeTab();
  const button = $('#allow-site');
  const status = $('#site-status');
  status.className = 'site-status';
  button.hidden = true;
  currentOrigin = tab?.url && scriptable(tab.url) ? originOf(tab.url) : null;
  if (!currentOrigin) {
    $('#site-name').textContent = tab?.url ? (originOf(tab.url) ? hostOf(tab.url) : 'This page') : '';
    status.textContent = 'Chrome does not allow extensions here';
    return;
  }
  const origin = originOf(tab.url);
  $('#site-name').textContent = hostOf(origin);
  if (await siteAllowed(origin)) {
    status.textContent = '✓ Allowed';
    status.classList.add('ok');
  } else {
    status.textContent = 'Not allowed yet';
    button.hidden = false;
  }
}

// Chrome grants a site only while handling the click, so nothing is awaited before asking.
$('#allow-site').addEventListener('click', async () => {
  if (currentOrigin) await allowSite(currentOrigin);
  updateSiteBar();
});

chrome.tabs.onActivated.addListener(() => updateSiteBar());
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.status === 'complete') updateSiteBar();
});
chrome.permissions.onAdded.addListener(() => updateSiteBar());
chrome.permissions.onRemoved.addListener(() => updateSiteBar());

// ── Talking to the page (page.js) ─────────────────────────────────────────

async function callPage(tabId, method, ...args) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['page.js'] });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name, params) => window.__agentPlatform[name](...params),
    args: [method, args],
  });
  return result?.result;
}

/** The page as the agent sees it, or just its address when the panel may not read it. */
async function pageState(tab) {
  const blank = { url: tab.url ?? '', title: tab.title ?? '', snapshot: '' };
  const origin = originOf(tab.url ?? '');
  if (!origin || !scriptable(tab.url) || !(await siteAllowed(origin))) return blank;
  try {
    return await callPage(tab.id, 'snapshot');
  } catch {
    return blank;
  }
}

async function waitForLoad(tabId) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === 'complete') break;
    await sleep(250);
  }
  // Pages often keep drawing for a moment after loading.
  await sleep(600);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Carrying out one action ───────────────────────────────────────────────

const VERB = { click: 'Click', type_text: 'Type into', select_option: 'Choose in', press_key: 'Press' };

/** Performs one browser action on the task's tab and returns what happened, for the agent. */
async function perform(call, tabId) {
  const args = call.arguments ?? {};
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return 'The tab was closed.';

  if (call.name === 'navigate') {
    const origin = originOf(String(args.url ?? ''));
    if (!origin) return 'That is not a web address (it must start with http:// or https://).';
    if (!(await siteAllowed(origin))) {
      const ok = await ask({
        title: `Open ${hostOf(origin)}?`,
        detail: `The agent wants to go to ${args.url} and work there.`,
        allow: 'Allow and open',
        onAllow: () => allowSite(origin),
      });
      if (!ok) return logStep(`Did not open ${hostOf(origin)}`, 'denied', 'The person did not allow that site.');
    }
    await chrome.tabs.update(tabId, { url: args.url });
    await waitForLoad(tabId);
    return logStep(`Opened ${hostOf(origin)}`, '', `Opened ${args.url}.`);
  }

  if (call.name === 'go_back') {
    await chrome.tabs.goBack(tabId).catch(() => {});
    await waitForLoad(tabId);
    return logStep('Went back', '', 'Went back to the previous page.');
  }

  const origin = originOf(tab.url ?? '');
  if (!origin || !scriptable(tab.url)) return 'Chrome does not let the agent act on this page.';
  if (!(await siteAllowed(origin))) {
    const ok = await ask({
      title: `Allow on ${hostOf(origin)}?`,
      detail: 'The agent needs to read and act on this site to continue.',
      allow: 'Allow',
      onAllow: () => allowSite(origin),
    });
    if (!ok) return logStep(`Not allowed on ${hostOf(origin)}`, 'denied', 'The person did not allow this site.');
  }

  if (call.name === 'scroll') {
    const result = await callPage(tabId, 'act', call);
    await sleep(400);
    return logStep(result, 'note', result);
  }

  // Look before acting: what the element is, and whether the person must approve.
  const isEnter = call.name === 'press_key' && /^enter$/i.test(String(args.key));
  const target = call.name === 'press_key' ? null : await callPage(tabId, 'describe', String(args.ref ?? ''), call.name === 'type_text' && args.submit ? 'enter' : call.name === 'click' ? 'click' : 'other');
  if (target && !target.found) return `There is no element ${args.ref} on the page now. Use a ref from the latest page.`;
  if (call.name === 'type_text' && target.password) {
    return logStep(`Left "${target.label}" for you to fill in`, 'denied', 'That is a password or payment field. Ask the person to fill it in themselves, then continue.');
  }

  const sensitive = target?.sensitive || (isEnter && (await callPage(tabId, 'describe', '', 'enter')).sensitive);
  if (sensitive) {
    const what = call.name === 'type_text' ? `Type into "${target.label}" and press Enter` : `${VERB[call.name] ?? call.name} "${target?.label ?? args.key}"`;
    const ok = await ask({
      title: `${what}?`,
      detail: `On ${hostOf(origin)}. ${args.reason ? `The agent says: ${args.reason}. ` : ''}This may send, submit or change something.`,
      allow: 'Allow',
    });
    if (!ok) return logStep(`You declined: ${what}`, 'denied', 'The person declined this action. Stop and ask what they would like to do instead.');
  }

  const result = await callPage(tabId, 'act', call);
  await waitForLoad(tabId);
  return logStep(result, '', result);
}

// ── The task loop ─────────────────────────────────────────────────────────

async function runTask(text) {
  if (running) return;
  running = true;
  stopRequested = false;
  setRunning(true);
  addUser(text);
  task.push({ role: 'user', content: text });
  const tab = await activeTab();
  const tabId = tab?.id;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (stopRequested) {
        logStep('Stopped', 'denied');
        return;
      }
      const current = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
      if (!current) {
        addError('The tab this task was working in was closed.');
        return;
      }
      const thinking = addThinking(step === 0 ? 'Reading the page…' : 'Thinking…');
      let result;
      try {
        result = await api('/api/browser/step', { messages: recent(task), page: await pageState(current) });
      } finally {
        thinking.remove();
      }

      if (result.type === 'answer') {
        task.push({ role: 'assistant', content: result.text });
        addAnswer(result.text, result.sources);
        return;
      }

      task.push(result.assistant, ...result.serverResults);
      if (result.assistant.content?.trim()) logStep(result.assistant.content.trim(), 'note');
      for (const call of result.browserCalls) {
        // Every call gets a result, even after Stop, so the conversation stays well formed.
        const content = stopRequested ? 'Stopped by the person.' : await perform(call, tabId);
        task.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
      }
    }
    addAnswer(`I stopped after ${MAX_STEPS} steps so you can check progress. Tell me to continue if you want me to carry on.`);
  } catch (err) {
    addError(err.message);
  } finally {
    running = false;
    setRunning(false);
    updateSiteBar();
  }
}

/** The task's latest messages, starting at a question so tool calls keep their results. */
function recent(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;
  let start = messages.length - MAX_MESSAGES;
  while (start < messages.length && messages[start].role !== 'user') start++;
  return messages.slice(start);
}

function stopTask() {
  stopRequested = true;
  pendingApproval?.(false);
}

function newTask() {
  stopTask();
  task = [];
  $('#log').replaceChildren($('#welcome'));
  $('#welcome').hidden = false;
}

$('#new-task').addEventListener('click', newTask);
$('#stop').addEventListener('click', stopTask);

// ── Rendering ─────────────────────────────────────────────────────────────

function append(node) {
  $('#welcome').hidden = true;
  $('#log').append(node);
  node.scrollIntoView({ block: 'end' });
  return node;
}

function addUser(text) {
  const div = document.createElement('div');
  div.className = 'user';
  div.textContent = text;
  append(div);
}

function addAnswer(text, sources = []) {
  const div = document.createElement('div');
  div.className = 'answer';
  div.append(renderMarkdown(text, { sources }));
  if (sources.length) {
    const list = document.createElement('div');
    list.className = 'sources';
    for (const s of sources) {
      const a = document.createElement('a');
      a.className = 'source';
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `${s.n} · ${hostOf(s.url)}`;
      a.title = s.title;
      list.append(a);
    }
    div.append(list);
  }
  append(div);
}

function addError(text) {
  const div = document.createElement('div');
  div.className = 'answer answer-error';
  div.textContent = text;
  append(div);
}

/** Shows one step in the log, and returns `forAgent` (what the agent is told happened). */
function logStep(text, kind = '', forAgent = text) {
  const div = document.createElement('div');
  div.className = `step ${kind}`;
  const span = document.createElement('span');
  span.textContent = text;
  div.append(span);
  append(div);
  return forAgent;
}

function addThinking(label) {
  const div = document.createElement('div');
  div.className = 'thinking';
  const dots = document.createElement('span');
  dots.className = 'dots';
  dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  const text = document.createElement('span');
  text.textContent = label;
  div.append(dots, text);
  return append(div);
}

/**
 * An approval card. Resolves true only if the person presses Allow (and,
 * when `onAllow` asks Chrome for a site permission, Chrome grants it).
 */
function ask({ title, detail, allow = 'Allow', onAllow }) {
  return new Promise((resolve) => {
    const card = document.createElement('div');
    card.className = 'approval';
    card.setAttribute('role', 'alertdialog');
    const heading = document.createElement('div');
    heading.className = 'approval-title';
    heading.textContent = title;
    const body = document.createElement('div');
    body.className = 'approval-detail';
    body.textContent = detail;
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.textContent = allow;
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'deny';
    no.textContent = 'Deny';
    actions.append(yes, no);
    card.append(heading, body, actions);
    append(card);
    yes.focus();

    const done = (answer) => {
      pendingApproval = null;
      card.classList.add('decided');
      yes.disabled = no.disabled = true;
      resolve(answer);
    };
    pendingApproval = done;
    yes.addEventListener('click', async () => done(onAllow ? !!(await onAllow()) : true));
    no.addEventListener('click', () => done(false));
  });
}

// ── The composer ──────────────────────────────────────────────────────────

const input = $('#input');

function setRunning(on) {
  $('#send').hidden = on;
  $('#stop').hidden = !on;
  updateSend();
}

function updateSend() {
  $('#send').disabled = running || !input.value.trim();
}

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  updateSend();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || running) return;
  input.value = '';
  input.style.height = 'auto';
  updateSend();
  runTask(text);
});

for (const button of document.querySelectorAll('.suggestion')) {
  button.addEventListener('click', () => runTask(button.textContent));
}

// ── Start ─────────────────────────────────────────────────────────────────

await loadSettings();
if (settings.token && settings.user) showMain();
else showSignIn();
