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

import { runAgent } from './agent.ts';
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
import { type Config, loadConfig } from './config.ts';
import { Store, type User } from './store.ts';
import { findTool, toolStates } from './tools.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const MAX_BODY_BYTES = 1_000_000;
const MAX_DOCUMENT_CHARS = 200_000;
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
  ) {
    super(message);
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user?: User;
}

export function createApp(deps: { config: Config; store: Store; brain: Brain }): Server {
  const { config, store, brain } = deps;

  const requireUser = (ctx: Ctx): User => {
    const token = readCookie(ctx.req.headers.cookie, SESSION_COOKIE);
    const session = token && verifySession(token, config.sessionSecret);
    const user = session ? store.getUser(session.tenantId, session.userId) : undefined;
    if (!user) throw new HttpError(401, 'Please sign in.');
    return user;
  };

  const requireAdmin = (ctx: Ctx): User => {
    const user = requireUser(ctx);
    if (user.role !== 'admin') throw new HttpError(403, 'Only a company admin can do that.');
    return user;
  };

  const startSession = (res: ServerResponse, user: User) => {
    const token = signSession(
      { tenantId: user.tenantId, userId: user.id, expiresAt: Date.now() + SESSION_DAYS * 864e5 },
      config.sessionSecret,
    );
    res.setHeader('set-cookie', sessionCookie(token, config.production));
  };

  type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
  const routes: Record<string, Handler> = {
    'POST /api/signup': async (ctx) => {
      if (!config.allowSignup) throw new HttpError(403, 'Sign-up is turned off on this server.');
      const body = await readJson(ctx.req);
      const companyName = text(body.companyName, 'Company name', 100);
      const name = text(body.name, 'Your name', 100);
      const email = emailAddress(body.email);
      const password = newPassword(body.password);
      if (store.findUserForLogin(email)) throw new HttpError(409, 'That email already has an account. Sign in instead.');
      const { tenant, user } = store.createTenantWithAdmin({ companyName, email, name, passwordHash: hashPassword(password) });
      store.audit(tenant.id, user.id, 'company_created', { company: tenant.name });
      startSession(ctx.res, user);
      return publicUser(user, tenant.name);
    },

    'POST /api/login': async (ctx) => {
      const body = await readJson(ctx.req);
      const found = store.findUserForLogin(String(body.email ?? ''));
      // The same message whether the email or the password was wrong.
      if (!found || !verifyPassword(String(body.password ?? ''), found.passwordHash)) {
        throw new HttpError(401, 'Email or password is incorrect.');
      }
      const { passwordHash: _, ...user } = found;
      store.audit(user.tenantId, user.id, 'signed_in');
      startSession(ctx.res, user);
      return publicUser(user, store.getTenant(user.tenantId)?.name ?? '');
    },

    'POST /api/logout': (ctx) => {
      ctx.res.setHeader('set-cookie', clearedSessionCookie(config.production));
      return { ok: true };
    },

    'GET /api/me': (ctx) => {
      const user = requireUser(ctx);
      return { ...publicUser(user, store.getTenant(user.tenantId)?.name ?? ''), brain: brain.name };
    },

    'GET /api/history': (ctx) => {
      const user = requireUser(ctx);
      const conversationId = store.latestConversation(user.tenantId, user.id);
      return { conversationId: conversationId ?? null, messages: conversationId ? store.getMessages(user.tenantId, conversationId) : [] };
    },

    'POST /api/chat': async (ctx) => {
      const user = requireUser(ctx);
      const body = await readJson(ctx.req);
      const question = text(body.message, 'Message', 8000);
      let conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
      if (conversationId && !store.ownsConversation(user.tenantId, user.id, conversationId)) {
        throw new HttpError(404, 'Conversation not found.');
      }
      if (!conversationId) conversationId = store.createConversation(user.tenantId, user.id);

      const history: ChatMessage[] = store
        .getMessages(user.tenantId, conversationId, HISTORY_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content }));
      store.addMessage(user.tenantId, conversationId, 'user', question);

      let result;
      try {
        result = await runAgent({
          brain,
          store,
          user,
          companyName: store.getTenant(user.tenantId)?.name ?? 'your company',
          history,
          question,
        });
      } catch (err) {
        store.audit(user.tenantId, user.id, 'error', { error: String(err) });
        throw new HttpError(502, err instanceof Error ? err.message : 'The AI brain failed.');
      }
      store.addMessage(user.tenantId, conversationId, 'assistant', result.reply);
      return { conversationId, ...result };
    },

    'POST /api/conversations': (ctx) => {
      const user = requireUser(ctx);
      return { conversationId: store.createConversation(user.tenantId, user.id) };
    },

    'GET /api/documents': (ctx) => {
      const user = requireUser(ctx);
      return { documents: store.listDocuments(user.tenantId) };
    },

    'POST /api/documents': async (ctx) => {
      const user = requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const title = text(body.title, 'Title', 200);
      const content = text(body.text, 'Document text', MAX_DOCUMENT_CHARS);
      const doc = store.addDocument(user.tenantId, title, content);
      store.audit(user.tenantId, user.id, 'document_added', { title, chars: content.length });
      return { id: doc.id, title: doc.title };
    },

    'DELETE /api/documents': (ctx) => {
      const user = requireAdmin(ctx);
      const id = ctx.url.searchParams.get('id') ?? '';
      if (!store.deleteDocument(user.tenantId, id)) throw new HttpError(404, 'Document not found.');
      store.audit(user.tenantId, user.id, 'document_deleted', { id });
      return { ok: true };
    },

    'GET /api/notes': (ctx) => {
      const user = requireUser(ctx);
      return { notes: store.listNotes(user.tenantId, user.id) };
    },

    'GET /api/admin/tools': (ctx) => {
      const user = requireAdmin(ctx);
      return { tools: toolStates(store, user.tenantId) };
    },

    'PUT /api/admin/tools': async (ctx) => {
      const user = requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const tool = findTool(String(body.name ?? ''));
      if (!tool) throw new HttpError(404, 'No such tool.');
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false.');
      store.setToolEnabled(user.tenantId, tool.name, body.enabled);
      store.audit(user.tenantId, user.id, 'tool_setting_changed', { tool: tool.name, enabled: body.enabled });
      return { tools: toolStates(store, user.tenantId) };
    },

    'POST /api/admin/users': async (ctx) => {
      const admin = requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const email = emailAddress(body.email);
      const name = text(body.name, 'Name', 100);
      const password = newPassword(body.password);
      const role = body.role === 'admin' ? 'admin' : 'member';
      if (store.findUserForLogin(email)) throw new HttpError(409, 'That email already has an account.');
      const user = store.addUser(admin.tenantId, { email, name, role, passwordHash: hashPassword(password) });
      store.audit(admin.tenantId, admin.id, 'user_added', { email, role });
      return publicUser(user, store.getTenant(admin.tenantId)?.name ?? '');
    },

    'GET /api/admin/audit': (ctx) => {
      const user = requireAdmin(ctx);
      return { entries: store.getAudit(user.tenantId) };
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

function isJson(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0].trim() === 'application/json';
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'That request is too large.');
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

function main(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const brain = createBrain(config);
  createApp({ config, store, brain }).listen(config.port, () => {
    console.log(`Agent Platform running at http://localhost:${config.port}`);
    console.log(`AI brain: ${brain.name}`);
    if (!process.env.SESSION_SECRET) console.log('No SESSION_SECRET set: sign-ins reset when the server restarts.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
