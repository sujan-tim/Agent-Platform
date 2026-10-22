/**
 * The web server: the JSON API under /api and the browser app from web/.
 *
 * `createApp` builds a server from its parts (settings, storage, brain) so the
 * tests can run the real routes against a throwaway database and the mock
 * brain. Run directly (`npm run dev`), it reads `.env`, opens the database and
 * listens on PORT.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MEMORIES_IN_PROMPT, runAgent } from './agent.ts';
import { browserStep, MAX_SNAPSHOT_CHARS, type PageState } from './browser-agent.ts';
import {
  clearedSessionCookie,
  hashPassword,
  readCookie,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionCookie,
  signSession,
  verifyPassword,
  verifySession,
} from './auth.ts';
import { createBrain, type Brain } from './brain/index.ts';
import type { ChatMessage } from './brain/types.ts';
import { type Config, loadConfig, type TrustProxy } from './config.ts';
import { createEmbedder, type Embedder, embedAllPending, embedPending } from './embed.ts';
import { ExtractError, extractFileText } from './extract.ts';
import { ADDRESS_LIMIT, EMAIL_LIMIT, type Limit, RateLimiter } from './ratelimit.ts';
import { createWebSearcher, type WebSearcher } from './websearch.ts';
import { createSheetService, type SheetService } from './sheetservice.ts';
import { Store, type User } from './store.ts';
import { findTool, toolStates } from './tools.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const MAX_BODY_BYTES = 1_000_000;
const MAX_DOCUMENT_CHARS = 200_000;
const MAX_UPLOAD_BYTES = 10_000_000;
// Uploads arrive as base64 inside JSON, which is a third larger than the file.
const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 10_000;
const HISTORY_MESSAGES = 20;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function tooManyAttempts(retryAfterMs: number): HttpError {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return new HttpError(429, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, {
    'retry-after': String(Math.ceil(retryAfterMs / 1000)),
  });
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user?: User;
}

export function createApp(deps: {
  config: Config;
  store: Store;
  brain: Brain;
  /** Turns on search by meaning; without it, search uses keywords. */
  embedder?: Embedder;
  /** Turns on the web tools; without it, they are not offered. */
  web?: WebSearcher;
  /** Connects companies to their Google Sheet; without it, the database tools are not offered. */
  sheets?: SheetService;
  /** Sign-in limits; tests pass small ones. */
  limits?: { email: Limit; address: Limit; browserSteps?: Limit };
}): Server {
  const { config, store, brain, embedder, web, sheets } = deps;
  const companiesOf = (user: User) => sheets?.forTenant(user.tenantId);
  const emailLimiter = new RateLimiter(deps.limits?.email ?? EMAIL_LIMIT);
  // A runaway extension task must not spend the whole AI allowance.
  const stepLimiter = new RateLimiter(deps.limits?.browserSteps ?? BROWSER_STEP_LIMIT);
  const addressLimiter = new RateLimiter(deps.limits?.address ?? ADDRESS_LIMIT);

  /** Counts a sign-in or sign-up attempt from this address, refusing it once over the limit. */
  const limitAddress = (ctx: Ctx) => {
    const address = clientAddress(ctx.req, config.trustProxy);
    const wait = addressLimiter.retryAfter(address);
    if (wait > 0) throw tooManyAttempts(wait);
    addressLimiter.record(address);
  };

  /**
   * Embeds a company's new passages so they can be found by meaning. A
   * failure is logged and reported, never fatal: the document is saved and
   * keyword search still finds it; the next start-up retries.
   */
  const indexDocuments = async (user: User): Promise<'meaning' | 'keywords'> => {
    if (!embedder) return 'keywords';
    try {
      await embedPending(store, embedder, user.tenantId);
      return 'meaning';
    } catch (err) {
      await store.audit(user.tenantId, user.id, 'embedding_failed', { error: String(err) });
      return 'keywords';
    }
  };

  const addDocument = async (user: User, title: string, content: string, source: Record<string, unknown>) => {
    const doc = await store.addDocument(user.tenantId, title, content);
    await store.audit(user.tenantId, user.id, 'document_added', { title, chars: content.length, ...source });
    return { id: doc.id, title: doc.title, chars: content.length, searchableBy: await indexDocuments(user) };
  };

  const requireUser = async (ctx: Ctx): Promise<User> => {
    // The browser app sends the session cookie; the Chrome extension, which cannot share
    // the site's cookies, sends the same signed session as a bearer token.
    const bearer = /^Bearer\s+(\S+)$/i.exec(ctx.req.headers.authorization ?? '')?.[1];
    const token = bearer ?? readCookie(ctx.req.headers.cookie, SESSION_COOKIE);
    const session = token && verifySession(token, config.sessionSecret);
    const user = session ? await store.getUser(session.tenantId, session.userId) : undefined;
    if (!user) throw new HttpError(401, 'Please sign in.');
    return user;
  };

  const requireAdmin = async (ctx: Ctx): Promise<User> => {
    const user = await requireUser(ctx);
    if (user.role !== 'admin') throw new HttpError(403, 'Only a company admin can do that.');
    return user;
  };

  const startSession = (res: ServerResponse, user: User): string => {
    const token = signSession(
      { tenantId: user.tenantId, userId: user.id, expiresAt: Date.now() + SESSION_DAYS * 864e5 },
      config.sessionSecret,
    );
    res.setHeader('set-cookie', sessionCookie(token, config.production));
    return token;
  };

  type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
  const routes: Record<string, Handler> = {
    /** What the sign-in page offers, before anyone signs in. */
    'GET /api/public': async () => ({
      allowSignup: config.allowSignup,
      accessRequests: !!(await store.accessRequestsTenant()),
    }),

    /** Someone asks to join; an admin of the receiving company approves or rejects it. */
    'POST /api/access-requests': async (ctx) => {
      limitAddress(ctx);
      const tenantId = await store.accessRequestsTenant();
      if (!tenantId) throw new HttpError(403, 'This site is not taking access requests. Ask your company admin to add you.');
      const body = await readJson(ctx.req);
      const name = text(body.name, 'Your name', 100);
      const email = emailAddress(body.email);
      const password = newPassword(body.password);
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
      // The same answer whether or not the email already has an account, so accounts cannot be discovered.
      if (!(await store.findUserForLogin(email))) {
        await store.createAccessRequest(tenantId, { name, email, passwordHash: hashPassword(password), note });
        await store.audit(tenantId, null, 'access_requested', { email, name });
      }
      return { ok: true, message: 'Request sent. You can sign in once an admin approves it.' };
    },

    'POST /api/signup': async (ctx) => {
      if (!config.allowSignup) throw new HttpError(403, 'Sign-up is turned off on this server.');
      limitAddress(ctx);
      const body = await readJson(ctx.req);
      const companyName = text(body.companyName, 'Company name', 100);
      const name = text(body.name, 'Your name', 100);
      const email = emailAddress(body.email);
      const password = newPassword(body.password);
      if (await store.findUserForLogin(email)) throw new HttpError(409, 'That email already has an account. Sign in instead.');
      const { tenant, user } = await store.createTenantWithAdmin({ companyName, email, name, passwordHash: hashPassword(password) });
      await store.audit(tenant.id, user.id, 'company_created', { company: tenant.name });
      startSession(ctx.res, user);
      return publicUser(user, tenant.name);
    },

    'POST /api/login': async (ctx) => {
      limitAddress(ctx);
      const body = await readJson(ctx.req);
      const email = String(body.email ?? '').trim().toLowerCase();
      // Checked before the password, so a locked-out guess is never tested.
      const wait = emailLimiter.retryAfter(email);
      if (wait > 0) throw tooManyAttempts(wait);
      const found = await store.findUserForLogin(email);
      // The same message whether the email or the password was wrong.
      if (!found || !verifyPassword(String(body.password ?? ''), found.passwordHash)) {
        emailLimiter.record(email);
        if (found) await store.audit(found.tenantId, found.id, 'sign_in_failed');
        // Only someone who knows the password they requested with learns that it is waiting.
        const waiting = !found && (await store.pendingAccessRequest(email));
        if (waiting && verifyPassword(String(body.password ?? ''), waiting.passwordHash)) {
          throw new HttpError(403, 'Your access request is waiting for an admin to approve it.');
        }
        throw new HttpError(401, 'Email or password is incorrect.');
      }
      emailLimiter.clear(email);
      const { passwordHash: _, ...user } = found;
      await store.audit(user.tenantId, user.id, 'signed_in', body.client === 'extension' ? { client: 'extension' } : {});
      const token = startSession(ctx.res, user);
      const result = publicUser(user, (await store.getTenant(user.tenantId))?.name ?? '');
      // The extension keeps the token in its own storage, which web pages cannot read.
      return body.client === 'extension' ? { ...result, token } : result;
    },

    /** For the host's health check: the server is up and the database answers. */
    'GET /api/health': async () => {
      await store.ping();
      return { ok: true };
    },

    'POST /api/logout': (ctx) => {
      ctx.res.setHeader('set-cookie', clearedSessionCookie(config.production));
      return { ok: true };
    },

    'GET /api/me': async (ctx) => {
      const user = await requireUser(ctx);
      return {
        ...publicUser(user, (await store.getTenant(user.tenantId))?.name ?? ''),
        brain: brain.name,
        search: embedder ? 'meaning' : 'keywords',
        web: !!web,
        database: !!(await companiesOf(user)),
      };
    },

    'GET /api/history': async (ctx) => {
      const user = await requireUser(ctx);
      const conversationId = await store.latestConversation(user.tenantId, user.id);
      return {
        conversationId: conversationId ?? null,
        messages: conversationId ? await store.getMessages(user.tenantId, conversationId) : [],
      };
    },

    'POST /api/chat': async (ctx) => {
      const user = await requireUser(ctx);
      const body = await readJson(ctx.req);
      const question = text(body.message, 'Message', 8000);
      let conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
      if (conversationId && !(await store.ownsConversation(user.tenantId, user.id, conversationId))) {
        throw new HttpError(404, 'Conversation not found.');
      }
      if (!conversationId) conversationId = await store.createConversation(user.tenantId, user.id);

      const history: ChatMessage[] = (await store.getMessages(user.tenantId, conversationId, HISTORY_MESSAGES)).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      await store.addMessage(user.tenantId, conversationId, 'user', question);

      let result;
      try {
        result = await runAgent({
          brain,
          store,
          embedder,
          web,
          companies: await companiesOf(user),
          user,
          companyName: (await store.getTenant(user.tenantId))?.name ?? 'your company',
          history,
          question,
        });
      } catch (err) {
        await store.audit(user.tenantId, user.id, 'error', { error: String(err) });
        throw new HttpError(502, err instanceof Error ? err.message : 'The AI brain failed.');
      }
      await store.addMessage(user.tenantId, conversationId, 'assistant', result.reply, {
        sources: result.sources,
        toolsUsed: result.toolsUsed,
      });
      return { conversationId, ...result };
    },

    'GET /api/conversations': async (ctx) => {
      const user = await requireUser(ctx);
      return { conversations: await store.listConversations(user.tenantId, user.id) };
    },

    'GET /api/conversation': async (ctx) => {
      const user = await requireUser(ctx);
      const id = ctx.url.searchParams.get('id') ?? '';
      if (!(await store.ownsConversation(user.tenantId, user.id, id))) throw new HttpError(404, 'Conversation not found.');
      return { conversationId: id, messages: await store.getMessages(user.tenantId, id, 200) };
    },

    'DELETE /api/conversation': async (ctx) => {
      const user = await requireUser(ctx);
      const id = ctx.url.searchParams.get('id') ?? '';
      if (!(await store.deleteConversation(user.tenantId, user.id, id))) throw new HttpError(404, 'Conversation not found.');
      await store.audit(user.tenantId, user.id, 'conversation_deleted', { id });
      return { ok: true };
    },

    // ── The company database (a Google Sheet) ──

    'GET /api/sheet': async (ctx) => {
      const user = await requireUser(ctx);
      const connection = await store.getSheetConnection(user.tenantId);
      const status = {
        configured: !!sheets,
        robotEmail: sheets?.robotEmail ?? null,
        connection: connection ?? null,
        pending: (await store.listSheetChanges(user.tenantId, 'pending')).length,
      };
      const db = await companiesOf(user);
      if (!db) return status;
      try {
        const { rows } = await db.load();
        const columns = (await db.profile()).map((p) => ({ name: p.name, filled: p.filled, internal: p.internal }));
        return { ...status, rows: rows.length, columns };
      } catch (err) {
        return { ...status, error: err instanceof Error ? err.message : String(err) };
      }
    },

    'POST /api/sheet/connect': async (ctx) => {
      const admin = await requireAdmin(ctx);
      if (!sheets) throw new HttpError(400, 'This server has no Google robot account set up (GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID).');
      const body = await readJson(ctx.req);
      const sheetId = sheetIdFrom(String(body.sheet ?? ''));
      // The same answer whether the sheet is unknown or taken, so IDs cannot be probed.
      const owner = await store.sheetOwner(sheetId);
      if (!sheets.isAllowed(sheetId) || (owner && owner !== admin.tenantId)) {
        throw new HttpError(403, 'That sheet is not available to connect. Check the ID, and that it is in SHEET_ID on the server.');
      }
      let tabs: string[];
      try {
        tabs = await sheets.tabs(sheetId);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      const tab = typeof body.tab === 'string' && body.tab ? body.tab : await sheets.guessTab(sheetId, tabs);
      if (!tabs.includes(tab)) throw new HttpError(400, `There is no tab "${tab}". Tabs: ${tabs.join(', ')}.`);
      sheets.forget(admin.tenantId);
      await store.connectSheet(admin.tenantId, admin.id, { sheetId, tab });
      await store.audit(admin.tenantId, admin.id, 'sheet_connected', { tab });
      return { connected: true, tab, tabs };
    },

    'DELETE /api/sheet': async (ctx) => {
      const admin = await requireAdmin(ctx);
      await store.disconnectSheet(admin.tenantId);
      sheets?.forget(admin.tenantId);
      await store.audit(admin.tenantId, admin.id, 'sheet_disconnected');
      return { ok: true };
    },

    'GET /api/sheet/changes': async (ctx) => {
      const user = await requireUser(ctx);
      const status = ctx.url.searchParams.get('status') ?? 'pending';
      if (!['pending', 'applied', 'rejected', 'failed', 'all'].includes(status)) throw new HttpError(400, 'Unknown status.');
      return { changes: await store.listSheetChanges(user.tenantId, status as 'pending') };
    },

    /** An admin approves (writes to the sheet) or rejects proposed changes. */
    'POST /api/sheet/changes/decide': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is number => Number.isInteger(id)).slice(0, 500) : [];
      if (ids.length === 0) throw new HttpError(400, 'Choose at least one change.');
      if (body.decision !== 'approve' && body.decision !== 'reject') throw new HttpError(400, '"decision" must be approve or reject.');
      const changes = (await store.getSheetChanges(admin.tenantId, ids)).filter((c) => c.status === 'pending');
      if (body.decision === 'reject') {
        for (const c of changes) await store.decideSheetChange(admin.tenantId, c.id, admin.id, 'rejected');
        await store.audit(admin.tenantId, admin.id, 'sheet_changes_rejected', { ids: changes.map((c) => c.id) });
        return { applied: 0, rejected: changes.length, failed: [] };
      }
      const db = await companiesOf(admin);
      if (!db) throw new HttpError(400, 'No sheet is connected.');
      const failed: Array<{ id: number; reason: string }> = [];
      let applied = 0;
      // In the order proposed, so later changes build on earlier ones.
      for (const c of changes) {
        let result: { ok: true } | { ok: false; reason: string };
        try {
          result =
            c.kind === 'add'
              ? await db.applyAdd(JSON.parse(c.newValue) as Record<string, string>)
              : await db.applyUpdate({ row: c.row!, company: c.company, column: c.column!, oldValue: c.oldValue ?? '', newValue: c.newValue });
        } catch (err) {
          result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
        if (result.ok) {
          applied++;
          await store.decideSheetChange(admin.tenantId, c.id, admin.id, 'applied');
        } else {
          failed.push({ id: c.id, reason: result.reason });
          await store.decideSheetChange(admin.tenantId, c.id, admin.id, 'failed', result.reason);
        }
      }
      await store.audit(admin.tenantId, admin.id, 'sheet_changes_applied', { applied, failed: failed.length });
      return { applied, rejected: 0, failed };
    },

    /** One step of a Chrome extension task; see src/browser-agent.ts. */
    'POST /api/browser/step': async (ctx) => {
      const user = await requireUser(ctx);
      const wait = stepLimiter.retryAfter(user.id);
      if (wait > 0) throw new HttpError(429, `That is a lot of steps at once. Try again in ${Math.ceil(wait / 1000)} seconds.`);
      stepLimiter.record(user.id);
      const body = await readJson(ctx.req, MAX_BROWSER_BODY_BYTES);
      const messages = browserMessages(body.messages);
      const page = pageState(body.page);
      try {
        return await browserStep({
          brain,
          store,
          embedder,
          web,
          companies: await companiesOf(user),
          user,
          companyName: (await store.getTenant(user.tenantId))?.name ?? 'your company',
          messages,
          page,
        });
      } catch (err) {
        await store.audit(user.tenantId, user.id, 'error', { error: String(err), via: 'extension' });
        throw new HttpError(502, err instanceof Error ? err.message : 'The AI brain failed.');
      }
    },

    'POST /api/conversations': async (ctx) => {
      const user = await requireUser(ctx);
      return { conversationId: await store.createConversation(user.tenantId, user.id) };
    },

    'GET /api/documents': async (ctx) => {
      const user = await requireUser(ctx);
      return { documents: await store.listDocuments(user.tenantId) };
    },

    'POST /api/documents': async (ctx) => {
      const user = await requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const title = text(body.title, 'Title', 200);
      const content = text(body.text, 'Document text', MAX_DOCUMENT_CHARS);
      return addDocument(user, title, content, { source: 'pasted' });
    },

    /** A PDF, Word, text or Markdown file, sent as base64 in JSON so the JSON-only rule still guards it. */
    'POST /api/documents/upload': async (ctx) => {
      const user = await requireAdmin(ctx);
      const body = await readJson(ctx.req, MAX_UPLOAD_BODY_BYTES);
      const filename = text(body.filename, 'File name', 255);
      const data = Buffer.from(typeof body.data === 'string' ? body.data : '', 'base64');
      if (data.length === 0) throw new HttpError(400, 'The file is empty.');
      if (data.length > MAX_UPLOAD_BYTES) throw new HttpError(413, `Files must be at most ${MAX_UPLOAD_BYTES / 1_000_000} MB.`);
      let extracted;
      try {
        extracted = await extractFileText(filename, data);
      } catch (err) {
        if (err instanceof ExtractError) throw new HttpError(400, err.message);
        throw err;
      }
      if (extracted.text.length > MAX_DOCUMENT_CHARS) {
        throw new HttpError(400, `That file has ${extracted.text.length.toLocaleString('en')} characters of text; the limit is ${MAX_DOCUMENT_CHARS.toLocaleString('en')}. Split it into smaller files.`);
      }
      const title =
        typeof body.title === 'string' && body.title.trim()
          ? text(body.title, 'Title', 200)
          : filename.replace(/\.[^.]+$/, '').slice(0, 200);
      return addDocument(user, title, extracted.text, { source: extracted.kind, filename, bytes: data.length });
    },

    'DELETE /api/documents': async (ctx) => {
      const user = await requireAdmin(ctx);
      const id = ctx.url.searchParams.get('id') ?? '';
      if (!(await store.deleteDocument(user.tenantId, id))) throw new HttpError(404, 'Document not found.');
      await store.audit(user.tenantId, user.id, 'document_deleted', { id });
      return { ok: true };
    },

    'GET /api/notes': async (ctx) => {
      const user = await requireUser(ctx);
      return { notes: await store.listNotes(user.tenantId, user.id) };
    },

    'GET /api/admin/tools': async (ctx) => {
      const user = await requireAdmin(ctx);
      return { tools: await toolStates(store, user.tenantId, { web, browser: true, companies: await companiesOf(user) }) };
    },

    'PUT /api/admin/tools': async (ctx) => {
      const user = await requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const tool = findTool(String(body.name ?? ''));
      if (!tool) throw new HttpError(404, 'No such tool.');
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false.');
      await store.setToolEnabled(user.tenantId, tool.name, body.enabled);
      await store.audit(user.tenantId, user.id, 'tool_setting_changed', { tool: tool.name, enabled: body.enabled });
      return { tools: await toolStates(store, user.tenantId, { web, browser: true, companies: await companiesOf(user) }) };
    },

    'POST /api/admin/users': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const email = emailAddress(body.email);
      const name = text(body.name, 'Name', 100);
      const password = newPassword(body.password);
      const role = body.role === 'admin' ? 'admin' : 'member';
      if (await store.findUserForLogin(email)) throw new HttpError(409, 'That email already has an account.');
      const user = await store.addUser(admin.tenantId, { email, name, role, passwordHash: hashPassword(password) });
      await store.audit(admin.tenantId, admin.id, 'user_added', { email, role });
      return publicUser(user, (await store.getTenant(admin.tenantId))?.name ?? '');
    },

    // ── The master prompt and team memory (admins) ──

    'GET /api/admin/master-prompt': async (ctx) => {
      const admin = await requireAdmin(ctx);
      return { text: await store.getMasterPrompt(admin.tenantId), max: MAX_MASTER_PROMPT };
    },

    'PUT /api/admin/master-prompt': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const value = typeof body.text === 'string' ? body.text.trim() : '';
      if (value.length > MAX_MASTER_PROMPT) throw new HttpError(400, `The master prompt must be at most ${MAX_MASTER_PROMPT} characters.`);
      await store.setMasterPrompt(admin.tenantId, admin.id, value);
      await store.audit(admin.tenantId, admin.id, 'master_prompt_changed', { chars: value.length });
      return { text: value };
    },

    'GET /api/admin/memories': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const [active, pending] = await Promise.all([store.listMemories(admin.tenantId, 'active'), store.listMemories(admin.tenantId, 'pending')]);
      return { active, pending, inPrompt: MEMORIES_IN_PROMPT };
    },

    'POST /api/admin/memories': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const fact = text(body.text, 'The memory', 200);
      await store.addMemory(admin.tenantId, admin.id, fact, 'active');
      await store.audit(admin.tenantId, admin.id, 'memory_added', { fact, status: 'active' });
      return { ok: true };
    },

    'POST /api/admin/memories/decide': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const body = await readJson(ctx.req);
      if (body.decision !== 'approve' && body.decision !== 'reject') throw new HttpError(400, '"decision" must be approve or reject.');
      if (!(await store.decideMemory(admin.tenantId, Number(body.id), admin.id, body.decision === 'approve' ? 'active' : 'rejected'))) {
        throw new HttpError(404, 'That memory is not waiting any more.');
      }
      await store.audit(admin.tenantId, admin.id, `memory_${body.decision === 'approve' ? 'approved' : 'rejected'}`, { id: Number(body.id) });
      return { ok: true };
    },

    'DELETE /api/admin/memories': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const id = Number(ctx.url.searchParams.get('id'));
      if (!(await store.deleteMemory(admin.tenantId, id))) throw new HttpError(404, 'No such memory.');
      await store.audit(admin.tenantId, admin.id, 'memory_deleted', { id });
      return { ok: true };
    },

    'GET /api/admin/access-requests': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const receiver = await store.accessRequestsTenant();
      return {
        enabled: receiver === admin.tenantId,
        // Another company on this server already receives them; only one can.
        takenElsewhere: !!receiver && receiver !== admin.tenantId,
        requests: await store.listAccessRequests(admin.tenantId),
      };
    },

    'PUT /api/admin/access-requests': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const body = await readJson(ctx.req);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false.');
      if (!(await store.setAccessRequestsTenant(admin.tenantId, body.enabled))) {
        throw new HttpError(409, 'Another company on this server already receives access requests.');
      }
      await store.audit(admin.tenantId, admin.id, 'access_requests_setting_changed', { enabled: body.enabled });
      return { enabled: body.enabled };
    },

    'POST /api/admin/access-requests/decide': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const id = Number(body.id);
      if (body.decision !== 'approve' && body.decision !== 'reject') throw new HttpError(400, '"decision" must be approve or reject.');
      const role = body.role === 'admin' ? 'admin' : 'member';
      const request = await store.decideAccessRequest(admin.tenantId, id, admin.id, body.decision === 'approve' ? 'approved' : 'rejected');
      if (!request) throw new HttpError(404, 'That request is not waiting any more.');
      if (body.decision === 'reject') {
        await store.audit(admin.tenantId, admin.id, 'access_rejected', { email: request.email });
        return { ok: true };
      }
      if (await store.findUserForLogin(request.email)) throw new HttpError(409, 'That email already has an account.');
      await store.addUser(admin.tenantId, { email: request.email, name: request.name, role, passwordHash: request.passwordHash });
      await store.audit(admin.tenantId, admin.id, 'access_approved', { email: request.email, role });
      return { ok: true };
    },

    'GET /api/admin/audit': async (ctx) => {
      const user = await requireAdmin(ctx);
      return { entries: await store.getAudit(user.tenantId) };
    },
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: Ctx = { req, res, url };
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (url.pathname.startsWith('/api/')) {
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) throw new HttpError(404, 'Not found.');
        // A JSON body can only be sent by script with CORS approval, which this
        // server never grants: that plus SameSite cookies blocks cross-site forgery.
        if (req.method !== 'GET' && req.method !== 'DELETE' && !isJson(req)) {
          throw new HttpError(415, 'Send JSON (content-type: application/json).');
        }
        sendJson(res, 200, await handler(ctx));
      } else {
        await serveStatic(url.pathname, res);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Something went wrong on the server.' });
      }
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function publicUser(user: User, companyName: string) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, companyName };
}

/**
 * The visitor's network address. Behind a proxy every request comes from the
 * proxy, so its header names the real visitor. With `local` the header is
 * believed only from this machine (a tunnel), since anyone else could send it
 * to dodge the sign-in limits; `all` is for hosts where the proxy is the only
 * way in.
 */
function clientAddress(req: IncomingMessage, trustProxy: TrustProxy): string {
  const socket = req.socket.remoteAddress ?? 'unknown';
  const local = socket === '127.0.0.1' || socket === '::1' || socket === '::ffff:127.0.0.1';
  if (trustProxy === 'off' || (trustProxy === 'local' && !local)) return socket;
  const forwarded = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim();
  return first || socket;
}

/** A sheet ID, from the ID itself or a full Google Sheets link. */
function sheetIdFrom(text: string): string {
  const fromLink = /\/spreadsheets\/d\/([\w-]+)/.exec(text)?.[1];
  const id = (fromLink ?? text).trim();
  if (!/^[\w-]{20,}$/.test(id)) throw new HttpError(400, 'Paste the sheet link, or the ID between /d/ and /edit in it.');
  return id;
}

/** Long enough for real guidance, short enough to leave room within free AI limits. */
const MAX_MASTER_PROMPT = 2000;

const MAX_BROWSER_BODY_BYTES = 400_000;
const MAX_BROWSER_MESSAGES = 80;
/** Extension steps per person: enough for long tasks, not for a loop gone wrong. */
const BROWSER_STEP_LIMIT: Limit = { max: 60, windowMs: 5 * 60_000 };

/** The extension's task so far, checked message by message. */
function browserMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, '"messages" must be a non-empty list.');
  if (value.length > MAX_BROWSER_MESSAGES) throw new HttpError(400, 'This task is too long; start a new one.');
  return value.map((m: any): ChatMessage => {
    const content = typeof m?.content === 'string' ? m.content.slice(0, 20_000) : '';
    if (m?.role === 'user') return { role: 'user', content };
    if (m?.role === 'tool' && typeof m.toolCallId === 'string' && typeof m.name === 'string') {
      return { role: 'tool', toolCallId: m.toolCallId, name: m.name, content };
    }
    if (m?.role === 'assistant') {
      const toolCalls = Array.isArray(m.toolCalls)
        ? m.toolCalls
            .filter((c: any) => typeof c?.id === 'string' && typeof c?.name === 'string')
            .map((c: any) => ({ id: c.id, name: c.name, arguments: c.arguments && typeof c.arguments === 'object' ? c.arguments : {} }))
        : undefined;
      return { role: 'assistant', content, ...(toolCalls?.length && { toolCalls }), ...(m.raw !== undefined && { raw: m.raw }) };
    }
    throw new HttpError(400, 'Each message needs a role of user, assistant or tool.');
  });
}

function pageState(value: unknown): PageState | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return { url: str(p.url, 2000), title: str(p.title, 500), snapshot: str(p.snapshot, MAX_SNAPSHOT_CHARS) };
}

function isJson(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0].trim() === 'application/json';
}

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'That request is too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'The request body must be a JSON object.');
}

function text(value: unknown, label: string, max: number): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new HttpError(400, `${label} is required.`);
  if (s.length > max) throw new HttpError(400, `${label} must be at most ${max} characters.`);
  return s;
}

function emailAddress(value: unknown): string {
  const email = text(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function newPassword(value: unknown): string {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters.');
  if (password.length > 200) throw new HttpError(400, 'Password must be at most 200 characters.');
  return password;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = normalize(join(WEB_DIR, relative));
  // Never serve anything outside web/.
  if (!file.startsWith(WEB_DIR.endsWith(sep) ? WEB_DIR : WEB_DIR + sep) || !CONTENT_TYPES[extname(file)]) {
    throw new HttpError(404, 'Not found.');
  }
  let content: Buffer;
  try {
    content = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not found.');
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)],
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(content);
}

// ── Entry point ───────────────────────────────────────────────────────────

/** Names the database for the log without its connection string, which holds the password. */
function describeDatabase(location: string): string {
  if (!/^postgres/.test(location)) return `PGlite in ${location}`;
  try {
    return `Postgres at ${new URL(location).hostname}`;
  } catch {
    return 'Postgres';
  }
}

/** Where data lived before the move to Postgres; copied over once, on start-up. */
const OLD_SQLITE_PATH = 'data/agent-platform.db';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const store = await Store.open(config.database);
  const imported = await store.importSqlite(OLD_SQLITE_PATH);
  if (imported) {
    console.log(`Copied the old SQLite database into ${describeDatabase(config.database)}:`, imported);
    console.log(`${OLD_SQLITE_PATH} is no longer used; delete it once everything looks right.`);
  }
  const brain = createBrain(config);
  const embedder = createEmbedder(config);
  const web = createWebSearcher();
  let sheets: SheetService | undefined;
  try {
    sheets = createSheetService(store);
  } catch (err) {
    console.warn(`Company database is off: ${err instanceof Error ? err.message : err}`);
  }
  createApp({ config, store, brain, embedder, web, sheets }).listen(config.port, () => {
    console.log(`Agent Platform running at http://localhost:${config.port}`);
    console.log(`AI brain: ${brain.name}`);
    console.log(`Database: ${describeDatabase(config.database)}`);
    console.log(`Document search: ${embedder ? `by meaning (${embedder.model}) and keywords` : 'keywords'}`);
    console.log(`Web search: ${web ? `on (${web.name})` : 'off (set TAVILY_API_KEY to turn it on)'}`);
    console.log(`Company database: ${sheets ? `ready (robot ${sheets.robotEmail}); connect it under Admin` : 'off (set GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID)'}`);
    if (!process.env.SESSION_SECRET) console.log('No SESSION_SECRET set: sign-ins reset when the server restarts.');
  });
  // Check embeddings work, then catch up on passages added while they were off or failing.
  if (embedder) {
    embedder
      .embed(['ping'], 'query')
      .then(() => embedAllPending(store, embedder))
      .then(
        (n) => n > 0 && console.log(`Embedded ${n} document passage${n === 1 ? '' : 's'} for search by meaning.`),
        (err) => console.warn(`Search by meaning is unavailable, using keywords: ${err instanceof Error ? err.message : err}`),
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
