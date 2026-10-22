# Agent Platform for Chrome

Your company's agent in Chrome's side panel. It reads the page you are on,
answers questions about it, and works through it for you: clicking, typing,
choosing options and moving between pages.

## Safety

- **Site by site.** It cannot see or touch a website until you press
  **Allow on this site**. Banking and payment sites get an extra warning.
- **Asks first.** Before anything that could send, submit, post, buy, pay or
  delete, it stops and shows **Allow / Deny**.
- **No passwords or card numbers.** It leaves those fields for you.
- **Pages cannot give it orders.** Page text is treated as information, never
  as instructions.
- **Stop** ends a task at once; a task also stops itself after 25 steps.
- **Company control.** Clicking and typing need the `browser_control` switch
  under **Admin → Tools** (off by default). Without it the extension can still
  read pages and answer questions. Every step is in the audit log.

## Install (until it is on the Chrome Web Store)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Press **Load unpacked** and choose this `extension` folder.
4. Pin it: puzzle-piece icon in the toolbar → pin **Agent Platform**.
5. Click its icon (or press Ctrl+Shift+Y, ⌘+Shift+Y on a Mac) to open the
   side panel, and sign in with your Agent Platform account. The server is
   filled in; change it if yours is elsewhere (for example
   `http://localhost:3000` when developing).

After changing the code, press the reload arrow on the extension's card in
`chrome://extensions`, then close and reopen the side panel.

## How it works

| File | What it does |
| --- | --- |
| `manifest.json` | Permissions: side panel, storage, scripting, tabs; sites only on request |
| `background.js` | Opens the side panel from the toolbar icon |
| `sidepanel.*` | Sign-in, chat, the task loop and the Allow / Deny cards |
| `page.js` | Runs in an allowed page when asked: describes it as text with element refs like `[e12]`, and performs actions |
| `markdown.js` | A copy of `web/markdown.js`, for formatted answers |

Each step, the panel sends the task so far and a text snapshot of the page to
`POST /api/browser/step` on the server (`src/browser-agent.ts`), which asks the
AI what to do next. Actions come back to the panel, which performs them on the
page (asking first when needed) and starts the next step with a fresh
snapshot.
