# 👻 PHANTOM AI — Telegram bot powered by Gemini

One codebase, deployed **twice**: one bot on **Render**, one bot on **Vercel**. Both are free.

## What it does

- 💬 Chats with memory (powered by Google Gemini)
- 🖼 Understands photos · 🎤 voice messages · 📄 PDFs and .txt files
- 🎭 `/mode` — assistant, coder, teacher, concise
- 🌍 `/translate`, 📝 `/summarize`, ✏️ `/fix`, 🕒 `/time`, 🪪 `/id`, 🧹 `/reset`
- 🔒 Optional allow-list so only you can use it (protects your free Gemini quota)
- 👥 Works in groups (reply to it or @mention it)

## Project layout

```
phantom-ai-bot/
├── src/
│   ├── bot.js          # commands + message handling (shared)
│   ├── ai.js           # Gemini calls, memory, personalities (shared)
│   └── format.js       # markdown -> Telegram HTML, long-message splitting
├── server.js           # RENDER entry point (Express web service)
├── api/
│   ├── webhook.js      # VERCEL entry point (serverless function)
│   └── set-webhook.js  # VERCEL one-time setup endpoint
├── public/index.html   # simple landing page for Vercel
├── vercel.json
├── render.yaml         # optional Render blueprint
├── package.json
└── .env.example
```

---

## Step 0 — Get your keys (5 minutes)

**Two Telegram bots.** A Telegram bot token can only point to ONE webhook, so you need two bots:

1. Open Telegram → chat with **@BotFather**
2. Send `/newbot` → name it e.g. `PHANTOM AI Vercel` → username e.g. `phantom_vercel_bot` → copy the token
3. Send `/newbot` again → `PHANTOM AI Render` → `phantom_render_bot` → copy the second token

**Gemini API key:** you already have it (https://aistudio.google.com/apikey). The same key can be used for both bots (they share one free quota).

**Webhook secret:** any long random string. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

(No Node installed? Just mash out 30+ random letters and numbers. Only `A-Z a-z 0-9 _ -` are allowed.)

Use the **same** `WEBHOOK_SECRET` for both deployments, or different ones. Either works.

---

## Step 1 — Put the code on GitHub

Both Render and Vercel deploy from a Git repo.

```bash
cd phantom-ai-bot
git init
git add .
git commit -m "PHANTOM AI bot"
```

Create an empty repo on https://github.com/new (private is fine), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/phantom-ai-bot.git
git branch -M main
git push -u origin main
```

`.env` is in `.gitignore`, so your secrets never get uploaded.

---

## Step 2A — Deploy on Vercel

1. Go to https://vercel.com → **Sign up with GitHub**.
2. **Add New… → Project** → **Import** your `phantom-ai-bot` repo.
3. Configure the project:
   - **Framework Preset:** `Other`
   - Leave Build Command, Output Directory and Install Command **empty / default**.
4. Open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `BOT_TOKEN` | the **Vercel bot's** token from BotFather |
   | `GEMINI_API_KEY` | your Gemini key |
   | `WEBHOOK_SECRET` | your random string |
   | `ALLOWED_USER_IDS` | *(optional, add later — see Step 3)* |

5. Click **Deploy**. Wait for the green "Congratulations" screen.
6. Register the webhook (one time). Open this URL in your browser, using your project's domain and your secret:

   ```
   https://YOUR-PROJECT.vercel.app/api/set-webhook?key=YOUR_WEBHOOK_SECRET
   ```

   You should see JSON with `"ok": true` and a `webhook` URL ending in `/api/webhook`.
7. Open the Vercel bot in Telegram and send `/start`. 🎉

> **Use the short production domain** (`YOUR-PROJECT.vercel.app`, shown under *Settings → Domains*), not the long per-deployment URL. The long URLs can be protected by Vercel login, which would block Telegram.
>
> If you add or change an environment variable later, **redeploy** (Deployments → ⋯ → Redeploy), then open the `set-webhook` URL again if you changed `BOT_TOKEN` or `WEBHOOK_SECRET`.

---

## Step 2B — Deploy on Render

1. Go to https://render.com → **Sign up with GitHub**.
2. **New + → Web Service** → connect your `phantom-ai-bot` repo.
3. Fill in:
   - **Name:** `phantom-ai-render` (anything)
   - **Language/Runtime:** `Node`
   - **Branch:** `main`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
4. Open **Advanced → Health Check Path** and set `/health`.
5. Under **Environment Variables** add:

   | Name | Value |
   |---|---|
   | `BOT_TOKEN` | the **Render bot's** token from BotFather (different from Vercel's) |
   | `GEMINI_API_KEY` | your Gemini key |
   | `WEBHOOK_SECRET` | your random string |
   | `ALLOWED_USER_IDS` | *(optional, add later)* |

6. Click **Create Web Service**. Watch the logs; success looks like:

   ```
   🚀 PHANTOM AI listening on port 10000
   ✅ Webhook set: https://phantom-ai-render.onrender.com/webhook
   ```

   The webhook is registered **automatically** on every start. Nothing else to do.
7. Message the Render bot on Telegram: `/start`. 🎉

### Keep Render awake (important on the free plan)

Free Render services **sleep after ~15 minutes without traffic**. The first message after a nap still arrives, but the reply can take 30–60 seconds. To avoid that:

1. Create a free account at https://uptimerobot.com
2. **Add New Monitor** → type `HTTP(s)` → URL `https://YOUR-SERVICE.onrender.com/health` → interval **5 minutes**.

A single always-on free service fits inside Render's monthly free instance hours.

---

## Step 3 — Lock the bot to yourself (recommended)

Right now anyone who finds your bot can use up your Gemini quota.

1. Send `/id` to each bot → it replies with your numeric user ID.
2. Add `ALLOWED_USER_IDS=123456789` (comma-separate several IDs) to the environment variables on **both** platforms.
   - **Render:** Environment tab → Save → it restarts automatically.
   - **Vercel:** Settings → Environment Variables → then **Redeploy**.
3. Anyone else now gets "🔒 This is a private bot."

---

## Troubleshooting

**Bot doesn't answer.** Ask Telegram what it sees (replace the token):

```
https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo
```

Look at `url` and `last_error_message`:

| Message | Fix |
|---|---|
| `url` is empty | Vercel: open the `set-webhook` link again. Render: check logs for "Webhook set". |
| `401 Unauthorized` | `WEBHOOK_SECRET` differs from what was registered. Redeploy, then re-run set-webhook (Vercel) or restart (Render). |
| `401` / HTML login page (Vercel) | You registered a protected deployment URL. Use the production domain. |
| `500` | Open the platform's logs; usually a missing environment variable. |

**"Rate limit" replies.** You hit the Gemini free-tier limits (shared by both bots). Wait a minute, or set `GEMINI_MODEL=gemini-3.5-flash-lite`, which is cheaper on quota.

**"Model not found."** Google retires and adds models over time. Set `GEMINI_MODEL` to a current one from https://ai.google.dev/gemini-api/docs/models

**Memory resets.** Chat memory lives in RAM: it clears when Vercel starts a fresh instance or Render restarts or sleeps. For permanent memory, add a free database (Upstash Redis or Supabase).

**Testing locally.** `cp .env.example .env`, fill it in, `npm install`, `npm run dev`. With no public URL it uses long-polling. **Use a third bot token for local testing**: polling on a token removes that bot's webhook.

---

## Notes

- On the Gemini **free tier**, Google may use your prompts to improve its products, so don't send private data you wouldn't want reviewed.
- The free tier also has no Google Search grounding, so the bot can't browse the web. It knows only what the model knows, plus today's date.

## Ideas to extend it

- Reminders / scheduled messages (needs a database + Vercel Cron or a Render cron job)
- Per-user saved notes with `/note` and `/notes`
- Image generation (paid Gemini models only)
- Function calling: let Gemini call your own APIs (weather, crypto prices, your calendar…)
