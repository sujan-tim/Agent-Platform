# Put Agent Platform online, free

This puts the app on the internet so anyone can open it, create a company
account and use it, without your Mac being on. Three free services, no credit
card:

| What | Service | Free plan, in short |
| --- | --- | --- |
| Runs the app | [Render](https://render.com) | Sleeps after 15 minutes with no visitors; the next visit takes about a minute to wake it |
| Keeps the data | [Neon](https://neon.tech) | A Postgres database, about 1 GB |
| The AI | [Groq](https://console.groq.com) | Llama models, with rate limits (roughly 30 questions a minute) |

It takes about 15 minutes. Free plans change; check each site's pricing page if
something below no longer matches.

## Before you start

Push the latest code to GitHub (Render deploys from there):

```bash
git add . && git commit -m "Hosting: Postgres, Groq, Render" && git push
```

## 1. Neon: the database

1. Sign up at <https://neon.tech> (signing in with GitHub is fine).
2. Create a project. Name it `agent-platform`. Pick the region closest to
   where Render will run: **US East (Ohio)** or **US West (Oregon)** both work
   with Render's default region, Oregon.
3. On the project's dashboard, press **Connect** and copy the **connection
   string**. It looks like
   `postgresql://user:password@ep-something.aws.neon.tech/neondb?sslmode=require`.
   Keep it to paste in step 3. It contains the password: don't share it or
   commit it.

## 2. Groq: the AI

1. Sign up at <https://console.groq.com>.
2. Go to **API Keys**, create a key named `agent-platform`, and copy it
   (it starts with `gsk_`). It is shown only once.

## 3. Render: the app

1. Sign up at <https://render.com> with your GitHub account.
2. Choose **New → Blueprint**, connect your GitHub account if asked, and pick
   the **Agent-Platform** repository. Render reads `render.yaml` and shows one
   web service, `agent-platform`, on the **Free** plan.
3. Render asks for two values:
   - `DATABASE_URL`: the Neon connection string from step 1.
   - `GROQ_API_KEY`: the Groq key from step 2.
4. Press **Apply**. The first build takes a few minutes. When the log shows
   `Agent Platform running`, the address at the top of the page
   (`https://agent-platform-xxxx.onrender.com`) is your site.

Open it, create your company account, and share the link.

## Afterwards

- **Updates.** Every `git push` to `main` redeploys automatically.
- **The first visit after a quiet spell** takes about a minute while Render
  wakes the app. That is the free plan; a paid instance removes it.
- **Your local data stays local.** The online site starts empty. To copy your
  laptop's data into it once, stop `npm run dev`, then run it with Neon:
  `DATABASE_URL='<Neon connection string>' npm start`. On start-up it copies the
  old `data/agent-platform.db` into the empty online database, then you can stop
  it. It never copies into a database that already has companies.
- **Turning off sign-up** (invited people only): in Render, open the service →
  **Environment**, add `ALLOW_SIGNUP` = `false`, and save. Admins can still add
  people from the Admin tab.
- **A better AI later.** Set `AI_PROVIDER` to `anthropic` and add
  `ANTHROPIC_API_KEY` in Render's Environment page. That one is paid.

## If something goes wrong

Render's **Logs** tab shows what the app printed.

| The log says | Fix |
| --- | --- |
| `AI_PROVIDER=groq needs GROQ_API_KEY` | Add the key under Environment |
| `groq rejected the API key` | The key was mistyped or deleted; make a new one |
| `groq's free limit is used up` | Wait a minute; it resets. Many users at once need a paid plan |
| `groq has no model "…"` | Groq retired that model. In Render → Environment, set `GROQ_MODEL` to the replacement listed at <https://console.groq.com/docs/deprecations> |
| `password authentication failed` or `ENOTFOUND` | `DATABASE_URL` is wrong; copy it again from Neon |
| `SESSION_SECRET must be set in production` | Add `SESSION_SECRET` with any long random text |

Company documents that people upload are sent to Groq to answer questions.
Check Groq's data terms before real companies upload private material.
