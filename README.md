# Agent Platform

A personal AI agent that companies subscribe to. Each company gets its own
space: its people sign in, chat by text or voice, and the agent answers from
the company's own documents, using only the tools that company's admin allows.

This is the first working skeleton. It runs on your laptop with a free AI model
through [Ollama](https://ollama.com), and switches to Claude later with one
setting.

## What it does today

- **Companies and people.** Anyone can create a company account; its first
  person is the admin, who can add others.
- **Chat with voice.** Type, or press the microphone and speak (Chrome or Edge).
  Tick "Read replies aloud" to hear answers.
- **Company documents.** Admins add text documents; the agent searches them to
  answer and says where the answer came from.
- **Tool rules per company.** Tools that only look things up are on. Tools that
  change something (today: saving a note) start off; an admin turns them on.
- **Audit log.** Every question, tool call, refusal and answer, per company.
- **Strict separation.** One company never sees another's documents,
  conversations, notes or logs.

## Run it on your Mac

You need Node.js 22.13 or newer (`node --version`).

1. **Install Ollama** from <https://ollama.com/download> and open it.
2. **Download a model** that can use tools (about 5 GB):
   ```bash
   ollama pull llama3.1
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

Small local models are noticeably weaker at choosing and using tools than
Claude; use Ollama to build, and Claude for customer demos.

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
| `src/store.ts` | All storage (SQLite), every query scoped to a company |
| `src/auth.ts` | Password hashing and signed sign-in cookies |
| `src/brain/` | One file per AI brain, all behind `src/brain/types.ts` |
| `web/` | The browser app (plain HTML, CSS and JavaScript) |
| `test/` | Tests: company separation, tool rules, the API end to end |

**Adding a tool:** add an entry to `TOOLS` in `src/tools.ts` with its `kind`
(`read` or `write`), a clear description, a JSON Schema for its arguments, and
a `run` function that takes the company from its context. Add a test.

**Adding a brain:** implement the `Brain` interface from `src/brain/types.ts`
in a new file and add it to `src/brain/index.ts`.

## Not built yet

Company single sign-on, email and calendar connectors, PDF and Word documents,
search by meaning, billing, sign-in rate limiting, and hosting. The project
plan lists the order.

## Notes

- Built on Node's built-in SQLite, which prints an "experimental" warning at
  start-up; that is expected.
- Never commit `.env` or any API key. `.gitignore` already excludes them.
