# Agent Platform

A personal AI agent that companies subscribe to. Each company gets its own
space: its people sign in, chat by text or voice, and the agent answers from
the company's own documents, using only the tools that company's admin allows.

This is the first working skeleton. It runs on your laptop with a free AI model
through [Ollama](https://ollama.com), and switches to Claude later with one
setting.

## What it does today

- **Jarvis.** A heads-up-display tab with an arc reactor, after the
  [Jarvis](https://github.com/adewaskar/jarvis) project. **Prompt** mode is
  typed; **Voice** mode is spoken (Chrome or Edge): press Space or tap the
  reactor, or turn on the "Hey Jarvis" wake word. He listens for a follow-up
  without the wake word, and you can talk over him to interrupt. It is the
  same agent and conversation as Chat, so the company's documents, tool rules
  and audit log all apply.
- **Company database (Google Sheets).** Connect a company's Google Sheet
  and ask about it in plain English ("which prospects in Brazil have no
  website?", "Net Sales by country"), find duplicates, and add or update
  companies. Every change is proposed into a **Review** tab and written to the
  sheet only after an admin approves it, after checking the row has not
  changed since. Internal columns (Status, Net Sales…) are never filled from
  the web.
- **Chrome extension.** A side panel that stays open next to any website,
  reads the page, and works through it for you (clicks, typing, forms,
  moving between pages), asking before anything that sends, submits, buys or
  deletes. See [extension/README.md](extension/README.md).
- **Master prompt and team memory.** Admins write standing instructions that
  every chat, Jarvis and the extension follow (Admin → Master prompt). Anyone
  can ask the agent to "remember for the team"; admins' memories apply at
  once, members' wait in Approvals. Chats themselves stay private to each person.
- **Private by default.** The sign-in page cannot create accounts. Admins
  add people, or approve requests from an optional "Request access" form.
  (`ALLOW_SIGNUP=true` reopens self-service company sign-up.)
- **Companies and people.** Anyone can create a company account; its first
  person is the admin, who can add others.
- **Chat with voice.** Type, or press the microphone and speak (Chrome or Edge).
  Tick "Read replies aloud" to hear answers.
- **Company documents.** Admins upload PDF, Word (.docx), text or Markdown
  files, or paste text; the agent searches them to answer and says where the
  answer came from. Scanned PDFs (pictures of pages) are refused for now.
- **Search by meaning.** With Ollama, documents are also searched by meaning,
  so "time off" finds a passage about "vacation days". Keyword search always
  runs too, and takes over on its own if embeddings are off or unavailable.
- **Live web search.** With a free [Tavily](https://tavily.com) key
  (`TAVILY_API_KEY`), the agent searches the web and reads pages for anything
  current or not in the company's documents, and gives the links it used.
  Company admins can switch each web tool off.
- **Tool rules per company.** Tools that only look things up are on. Tools that
  change something (today: saving a note) start off; an admin turns them on.
- **Audit log.** Every question, tool call, refusal and answer, per company.
- **Sign-in protection.** Five wrong passwords lock that email for 15 minutes;
  one network address gets 30 sign-in or sign-up attempts per 15 minutes.
- **Strict separation.** One company never sees another's documents,
  conversations, notes or logs.

## Run it on your Mac

You need Node.js 22.13 or newer (`node --version`).

1. **Install Ollama** from <https://ollama.com/download> and open it.
2. **Download a model** that can use tools (about 5 GB), and the small model
   that powers search by meaning (about 270 MB):
   ```bash
   ollama pull llama3.1
   ollama pull nomic-embed-text
   ```
3. **Install and start the app** (from this folder):
   ```bash
   npm install
   cp .env.example .env
   npm run dev
   ```
4. Open **http://localhost:3000**, create a company account, add a document
   under **Documents**, and ask about it in **Chat**.

No Ollama yet? Set `AI_PROVIDER=mock` in `.env` to try the app with a scripted
brain: it answers "time", "search …" and "note …" questions by rule.

## Switch the AI brain

The brain is chosen by `AI_PROVIDER` in `.env`:

| Value | Brain | Needs |
| --- | --- | --- |
| `ollama` | A free model on your machine | Ollama running, a model pulled |
| `mock` | Scripted replies | Nothing (used by the tests) |
| `anthropic` | Claude | `ANTHROPIC_API_KEY` from console.anthropic.com |
| `groq` | Llama models on Groq's servers (free tier, rate-limited) | `GROQ_API_KEY` from console.groq.com; `GROQ_MODEL` picks the model |

Search by meaning is set separately by `EMBEDDINGS` (`ollama` or `off`). It
defaults to `ollama` with the Ollama brain and `off` otherwise; Claude has no
embeddings service, so with Claude set `EMBEDDINGS=ollama` to keep using a
local Ollama for search. Documents added while embeddings were unavailable are
embedded at the next start-up.

Small local models are noticeably weaker at choosing and using tools than
Claude; use Ollama to build, and Claude for customer demos.

## Put it online

[DEPLOY.md](DEPLOY.md) puts it on the internet for free (Render, Neon and Groq),
so anyone can sign up without your Mac being on. `render.yaml` holds the
settings.

## Where the data lives

In Postgres. On a laptop nothing needs installing: the app runs Postgres
inside Node ([PGlite](https://pglite.dev)) and keeps it in `data/pglite`.
Hosted, set `DATABASE_URL` to a Postgres connection string (Neon, for example).
Run one copy of the app per `data/pglite` folder at a time.

Data from before the move to Postgres (`data/agent-platform.db`, SQLite) is
copied in automatically the first time the app starts with an empty database.

## Develop

```bash
npm run check   # type check + all tests (uses the mock brain; no model needed)
npm test        # tests only
```

How the code is laid out:

| Path | What it is |
| --- | --- |
| `src/server.ts` | Web server and JSON API (`/api/...`), plus the entry point |
| `src/agent.ts` | The agent loop and the tool gate |
| `src/tools.ts` | The tools, each marked `read` or `write` |
| `src/store.ts` | All storage, every query scoped to a company; document search |
| `src/db.ts` | The Postgres connection: a server when hosted, PGlite on a laptop |
| `src/embed.ts` | Search by meaning: embeddings from Ollama |
| `src/extract.ts` | Text out of PDF, Word, text and Markdown uploads |
| `src/ratelimit.ts` | Sign-in and sign-up rate limits |
| `src/websearch.ts` | Live web search and page reading (Tavily) |
| `src/auth.ts` | Password hashing and signed sign-in cookies |
| `src/brain/` | One file per AI brain, all behind `src/brain/types.ts` |
| `src/google.ts` | The robot Google account's sign-in, and a small Sheets client |
| `src/companydb.ts` | The company database: a sheet tab read, searched and updated like a table |
| `src/sheetservice.ts` | Which company has connected which sheet |
| `src/browser-agent.ts` | The Chrome extension's agent: one page step at a time |
| `extension/` | The Chrome extension (side panel) |
| `web/` | The browser app (plain HTML, CSS and JavaScript); `web/jarvis.js` is the Jarvis tab |
| `test/` | Tests: company separation, tool rules, the API end to end |

**Adding a tool:** add an entry to `TOOLS` in `src/tools.ts` with its `kind`
(`read` or `write`), a clear description, a JSON Schema for its arguments, and
a `run` function that takes the company from its context. Add a test.

**Adding a brain:** implement the `Brain` interface from `src/brain/types.ts`
in a new file and add it to `src/brain/index.ts`.

## Not built yet

Company single sign-on, email and calendar connectors, reading scanned PDFs
(OCR), billing, and search by meaning when hosted (it needs an embeddings
service there). The project plan lists the order.

Known limits of what is built:
- Sign-in limits are kept in memory: they reset on restart and are not shared
  between servers. Behind a proxy, set `TRUST_PROXY` (`local` for a tunnel on
  this machine, `all` for a host like Render) so each visitor is counted by
  their own address.
- Search by meaning compares the question with every passage of the company,
  which is quick up to tens of thousands of passages; beyond that it needs a
  vector index (pgvector, which Neon offers).

## Notes

- Tests run on a throwaway PGlite database each, so they need nothing
  installed and take about 20 seconds.
- Never commit `.env` or any API key. `.gitignore` already excludes them.
