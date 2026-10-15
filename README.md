# 👻 PHANTOM AI v2.2 — Telegram assistant powered by Gemini

One codebase, deployable on **Vercel** and/or **Render**. Free.

## What it does

**Talk to it**
- 💬 Chat with memory that **survives restarts** (needs the free database)
- 🖼 Photos · 🎤 voice notes · 📄 PDFs and .txt files · 🔗 links (it reads the page)
- 🎭 Personalities: assistant, coder, teacher, concise, naija buddy, life coach, creative writer, **plus your own** (`/persona`)

**It can DO things** (function calling: just ask in plain words)
- 🌦 Weather: "weather in Paris?"
- 📰 News: "latest news about football"
- 💱 Prices and rates: "price of bitcoin", "convert 200 USD to NGN"
- 📚 Wikipedia lookups · 🧮 exact calculator (percentages too) · 🕒 time in any city
- ⏰ **Reminders**: "remind me tomorrow at 9am to call mum", or repeating: "every weekday at 8am take my vitamins", or yearly ("every year on 25 Dec")
- 🤖 **AI-written scheduled messages**: "every morning send me a motivating quote" — Gemini writes it fresh each time it's due
- ✅ **To-do list**: "add milk to my to-do list" (tick items off with buttons)
- 🧠 **Saved facts**: "remember that I'm vegetarian" (it uses them in later chats)
- 🌅 **Daily briefing**: weather + news + your reminders, sent every morning
- 📝 **Notes**: "note this: idea for the weekend" — searchable later
- 💰 **Expense tracker**: "I spent 2k on transport" / send a receipt photo — categorised automatically, with a monthly budget bar
- 🔁 **Habit tracker**: "track a habit called gym" / "I did my workout" — daily streaks
- 🔔 **Price alerts**: "tell me when bitcoin goes above 70000" or "usd/ngn below 1500" — checked every 5 minutes
- 👀 **Page watcher**: "watch this page and tell me if it changes" + a link — checked every 30 minutes
- 🌐 Optional live web search (add a free Tavily key)

**🎮 Games — `/games`** (all offline: no API key, no internet data, no Gemini quota used)
Trivia (9 categories) · Hangman (5 categories) · Riddles · Emoji quiz · Would-you-rather ·
Truth or dare · Guess the number · Tic-tac-toe (vs the bot) · Rock-paper-scissors ·
Dice / coin flip / card draw · Word chain (play with friends in a group) · Jokes, quotes & random facts ·
Magic 8-ball · a personal scoreboard across all of them.

**Buttons**
- `/menu` opens a button menu
- Under every answer: 🔄 Regenerate · ✂️ Shorter · 🧹 New chat

> **No new environment variables or database changes are needed for v2.2.** Games, notes, expenses and
> habits work even without Upstash connected (they just won't survive a restart). Price alerts,
> page watching and scheduled AI messages need Upstash, same as reminders already did.

## Commands

| Command | What it does |
|---|---|
| `/menu` | Button menu |
| `/mode` | Pick a personality (buttons) |
| `/persona add name \| instructions` | Create your own personality |
| `/persona delete name` | Delete it |
| `/remember <fact>` · `/facts` · `/forget <n\|all>` | What I know about you |
| `/remind <when and what>` · `/reminders` | Reminders, one-off or repeating (list/cancel with buttons) |
| `/todo` · `/todo buy milk` · `/todo done 2` · `/todo del 2` · `/todo clear` | To-do list (also tick items with buttons) |
| `/briefing` | Daily briefing settings |
| `/briefing time 07:30` · `city Paris` · `topics tech, football` · `on` · `off` · `now` | Configure it |
| `/timezone Continent/City` | **Set this first**, so reminders and the briefing use your clock |
| `/games` | 🎮 Games menu — trivia, hangman, puzzles, tic-tac-toe and more |
| `/note <text>` · `/notes` · `/findnote <word>` | Save and search quick notes |
| `/spent <amount> <what>` · `/expenses` | Log an expense (`5k`/`1.5k`/`2m` all work) · spending summary & budget |
| `/habit add <name>` · `/habit del <n>` · `/habits` | Track daily habits and streaks |
| `/alerts` | Your active price alerts (set them by just asking, e.g. "alert me when eth hits 4000") |
| `/watching` | Pages you're watching for changes |
| `/translate` · `/summarize` · `/fix` | One-off helpers (also work on a replied message) |
| `/reset` | Fresh chat (saved facts are kept) |
| `/me` | Your settings, and whether the database is connected |
| `/id` | Your Telegram user ID |

## Project layout

```
phantom-ai-bot/
├── src/
│   ├── bot.js        # commands, menus, buttons (shared)
│   ├── ai.js         # Gemini chat + function-calling loop + personas (shared)
│   ├── tools.js      # everything Gemini can DO: weather, news, reminders... (shared)
│   ├── games.js       # offline games: trivia, hangman, tic-tac-toe, word chain...
│   ├── data.js        # built-in content for the games (no API, no keys)
│   ├── features.js    # notes / expenses / habits / price alerts / page watches logic
│   ├── extras.js       # button views for notes / expenses / habits / alerts / watches
│   ├── kb.js           # shared keyboard + view-rendering helpers
│   ├── store.js      # database layer (Upstash Redis, RAM fallback)
│   ├── scheduler.js  # sends due reminders, briefings, price alerts & page-watch checks
│   ├── timeutil.js   # time-zone maths
│   └── format.js     # markdown -> Telegram HTML, message splitting
├── server.js         # RENDER entry point
├── api/
│   ├── webhook.js    # VERCEL entry point
│   ├── set-webhook.js# VERCEL one-time setup endpoint
│   └── cron.js       # VERCEL "every minute" endpoint (reminders + briefing)
├── public/index.html
├── vercel.json · render.yaml · package.json · .env.example
```

---

## Environment variables

| Name | Required | What to put |
|---|---|---|
| `BOT_TOKEN` | ✅ | Token from @BotFather (a **different** bot per platform) |
| `GEMINI_API_KEY` | ✅ | From aistudio.google.com/apikey |
| `WEBHOOK_SECRET` | ✅ | Any long random text you make up (letters/numbers/`_`/`-`) |
| `UPSTASH_REDIS_REST_URL` | for memory, reminders, briefing, facts | From Upstash (see below) |
| `UPSTASH_REDIS_REST_TOKEN` | same | From Upstash |
| `ALLOWED_USER_IDS` | recommended | Your Telegram ID from `/id` (comma-separate several) |
| `NEWS_COUNTRY` | optional | 2-letter country for headlines, e.g. `NG`, `GB`, `US`, `KE`. Default `US` |
| `TAVILY_API_KEY` | optional | Enables live web search (free key at tavily.com; check their current free limits) |
| `CRON_SECRET` | optional | Separate password for the cron URL. Defaults to `WEBHOOK_SECRET` |
| `DAILY_MESSAGE_LIMIT` | optional | Max AI messages per user per day, e.g. `50`. Empty = unlimited. Protects your Gemini quota |
| `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` | optional | Defaults `gemini-3.5-flash` / `gemini-3.5-flash-lite` |

---

## Add the database (needed for reminders, briefing, saved facts, permanent memory)

Without it the bot still works, but memory resets on restarts and `/remind` and `/briefing` say they need the database.

**Option A: Upstash directly (works for Vercel AND Render)**
1. Sign up at https://upstash.com (free plan, no card).
2. **Create Database** → type **Redis** → pick the region closest to you → plan **Free**.
3. Open the database and scroll to the **REST API** section (or the `.env` tab).
4. Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
5. Add both as environment variables on Vercel (and Render if you use it).

**Option B: from Vercel's Storage tab**
Project → **Storage** → add **Upstash Redis** and connect it to the project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. The bot accepts these names too.

The free plan lists 500K commands per month and about 250 MB (check upstash.com/pricing/redis for current numbers). An idle minute timer costs 1 command per tick, about 43,000 a month, and each chat message uses roughly 3 to 4, so one person stays far below the limit.

---

## Set up the minute timer (needed for reminders + daily briefing)

Vercel's free plan can't run a job every minute, so a free outside timer pokes the bot.

**On Vercel**
1. Sign up free at https://cron-job.org
2. **Create cronjob**
   - **URL:** `https://YOUR-PROJECT.vercel.app/api/cron?key=YOUR_WEBHOOK_SECRET`
   - **Schedule:** every **1 minute**
3. Save. Open the same URL in your browser once: you should see `{"ok":true,"processed":0,"database":true}`.
   If `database` says `false`, the Upstash variables are missing or you haven't redeployed since adding them.

cron-job.org is free and allows a 1-minute interval. It gives up on a call after 30 seconds, so if a briefing ever takes longer it may log a failed run, but the bot still finishes and sends it (each reminder or briefing is claimed once, so nothing is sent twice).

If every-minute isn't available for you, UptimeRobot (free) can ping the same URL every 5 minutes. Reminders may then arrive up to 5 minutes late.

**On Render**
Nothing to do. The server checks every minute by itself while it's awake. Keep it awake with an UptimeRobot monitor on `/health` (see below).

---

## First deployment (from scratch)

### Step 0: Keys
1. In Telegram, message **@BotFather** → `/newbot` → copy the token. Make a second bot if you want both platforms.
2. Make up a `WEBHOOK_SECRET`.
3. Create the Upstash database (above).

### Step 1: GitHub
Create a repo, upload/push the project. `.env` is git-ignored, so secrets never get uploaded.

### Step 2A: Vercel
1. vercel.com → **Add New → Project** → import the repo.
2. **Application Preset: `Other`** (not Express). Leave build settings empty.
3. Add the environment variables from the table above, then **Deploy**.
4. Open `https://YOUR-PROJECT.vercel.app/api/set-webhook?key=YOUR_WEBHOOK_SECRET` once. You should see `"ok": true`.
5. Set up the minute timer (above).

### Step 2B: Render
1. render.com → **New + → Web Service** → connect the repo.
2. Runtime **Node**, Build `npm install`, Start `npm start`, Instance **Free**, Health Check Path `/health`.
3. Add the environment variables, then **Create Web Service**.
4. The logs should show `✅ Webhook set: ...` and `⏰ Reminders & daily briefing: scheduler running`.
5. Free Render services sleep after about 15 minutes idle. Add a free UptimeRobot monitor on `https://YOUR-SERVICE.onrender.com/health` every 5 minutes.

---

## 🔄 How to update an existing bot to this version

Your bot is already connected to GitHub, so updating = change the files, then let Vercel redeploy. Do it in this order so you only deploy once:

**1. Add the new environment variables first** (Vercel → project → **Settings → Environment Variables**)
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (from the database step)
- Optional: `NEWS_COUNTRY`, `ALLOWED_USER_IDS`, `TAVILY_API_KEY`

**2. Put the new files on GitHub**
- *No git needed:* unzip the project → open your repo on github.com → **Add file → Upload files** → drag in **everything inside the unzipped folder** (including the `src` and `api` folders) → **Commit changes**. Files with the same name get replaced.
- *With git:* copy the new files over your project folder, then:
  ```bash
  git add .
  git commit -m "PHANTOM AI v2"
  git push
  ```

**3. Wait for Vercel.** Project → **Deployments**: the top one must say **Ready**. If you added variables after the last deploy, also click **⋯ → Redeploy** so they apply.

**4. Re-register the webhook (important this time).** Open
`https://YOUR-PROJECT.vercel.app/api/set-webhook?key=YOUR_WEBHOOK_SECRET`
This tells Telegram to also send **button presses**, and refreshes the "/" command menu. Without it the buttons won't work.

**5. Set up the minute timer** (cron-job.org section above).

**6. Test it**
1. `/me` → should say `Storage: permanent (Upstash) ✅`
2. `/timezone Africa/Lagos` (or your own city's zone)
3. `/menu` → tap around
4. "Remind me in 2 minutes to test" → wait for the ⏰ message
5. `/briefing city YourCity` → `/briefing now`, then `/briefing on` (and `/briefing time 07:30`) to get it every day
6. "Remember that I like coffee" → `/facts`
7. `/todo buy milk` → tap the number to tick it
8. "Remind me every weekday at 8am to stretch" → `/reminders` shows 🔁
9. `/games` → tap around (trivia, hangman, tic-tac-toe...)
10. `/note Buy eggs` → `/notes` shows it
11. `/spent 2500 lunch` → `/expenses` shows the total
12. `/habit add Drink water` → `/habits`, tap to mark today done
13. "Tell me when bitcoin goes above 100000" → `/alerts` shows it
14. "Every morning at 8 send me a short motivational quote" → an AI-written message, not a fixed one

**Later updates:** edit or upload files on GitHub → Vercel redeploys automatically in about a minute.
Extra steps only when:
- you **add a command or button type** → open the `set-webhook` link again;
- you **change an environment variable** → redeploy;
- you **change `BOT_TOKEN` or `WEBHOOK_SECRET`** → redeploy, then open the `set-webhook` link again.

On Render, pushing to GitHub redeploys it and it re-registers its own webhook.

---

## Troubleshooting

**Bot silent.** Open `https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo` and read `last_error_message`:

| Message | Fix |
|---|---|
| `url` empty | Vercel: open the `set-webhook` link. Render: check logs for "Webhook set". |
| `401` | `WEBHOOK_SECRET` doesn't match. Redeploy, then run `set-webhook` again. |
| `500` | Open the platform's logs: usually a missing environment variable. |

**Buttons do nothing.** You skipped step 4 of the update. Open the `set-webhook` link.

**`/me` says "temporary, RAM only".** The Upstash variables are missing or wrong, or you haven't redeployed since adding them.

**Reminders or briefing never arrive.** Check, in order: `/me` shows permanent storage; `/timezone` is set; the cron-job.org job is running every minute and its URL shows `"ok":true` in your browser.

**"Rate limit" replies.** Gemini free-tier limits are shared by all your bots. A question that uses a tool costs about 2 Gemini requests (one to pick the tool, one to answer), and a daily briefing costs 1.

**Wrong time on reminders.** Send `/timezone Continent/City`. Until you do, UTC is assumed.

---

## Notes

- **Privacy:** chat history and saved facts are stored in *your* Upstash database. On the Gemini free tier, Google may use prompts to improve its products, so avoid sending secrets.
- **Link reading:** the bot refuses addresses on private networks (localhost, 10.x, 192.168.x and similar). Use `ALLOWED_USER_IDS` so only you can ask it to open links.
- **Data sources (all free, no key):** Open-Meteo (weather), Google News RSS (headlines, an unofficial feed that may change), CoinGecko (crypto, rate-limited), Wikipedia, and exchange rates by [Exchange Rate API](https://www.exchangerate-api.com), whose free endpoint asks for this attribution.
- **Local testing:** `cp .env.example .env`, fill it in, `npm install`, `npm run dev` (long-polling). Use a third bot token, because polling removes that bot's webhook.

## Ideas for next

- Group assistant: summarise a group's day
- Voice replies (text-to-speech)
- Inline mode (`@yourbot question` in any chat)
- Image generation (Gemini's image models are paid only)
