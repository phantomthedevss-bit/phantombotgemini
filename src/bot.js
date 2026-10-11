// src/bot.js — the bot itself. Shared by BOTH the Render server and the Vercel function.
import { Bot, InlineKeyboard } from "grammy";
import { chat, regenerate, oneShot, MODES, resolvePersona, friendlyError } from "./ai.js";
import { createStore } from "./store.js";
import { replyLong, sendLongTo } from "./format.js";
import { buildBriefing } from "./scheduler.js";
import { isValidTimeZone, formatLocal, parseHHMM, REPEAT_LABELS } from "./timeutil.js";

/** Shown in Telegram's "/" command menu (set automatically on startup / setup). */
export const COMMANDS = [
  { command: "menu", description: "Open the button menu" },
  { command: "help", description: "What I can do" },
  { command: "mode", description: "Switch personality" },
  { command: "persona", description: "Create your own personality" },
  { command: "remember", description: "Save a fact about you" },
  { command: "facts", description: "See / delete what I know about you" },
  { command: "remind", description: "/remind call mum in 2 hours" },
  { command: "reminders", description: "See / cancel reminders" },
  { command: "todo", description: "Your to-do list" },
  { command: "briefing", description: "Daily morning briefing" },
  { command: "timezone", description: "/timezone Europe/London" },
  { command: "translate", description: "/translate french Good morning" },
  { command: "summarize", description: "Summarize text or a replied message" },
  { command: "fix", description: "Fix grammar and spelling" },
  { command: "reset", description: "Start a fresh chat" },
  { command: "time", description: "/time Asia/Tokyo" },
  { command: "me", description: "Your profile & settings" },
  { command: "id", description: "Show your Telegram ID" },
  { command: "start", description: "Wake up PHANTOM AI" },
];

export const ALLOWED_UPDATES = ["message", "callback_query"];

const MAX_FILE_BYTES = 15 * 1024 * 1024;

const HELP = `👻 PHANTOM AI — what I can do

💬 Just talk to me. I remember our conversation, even after restarts.
🖼 Send a photo · 🎤 a voice note · 📄 a PDF or .txt, and ask me about it.
🔗 Send me a link and ask me to summarize it.

I can also DO things when you ask in plain words:
• "What's the weather in Paris?"
• "Latest news about football"
• "Price of bitcoin in USD" · "Convert 200 USD to NGN"
• "Remind me tomorrow at 9am to call mum"
• "Remind me every weekday at 8am to take my vitamins"
• "Add milk and bread to my to-do list"
• "Remember that I'm vegetarian"
• "Send me a daily briefing at 7:30 with tech news"

Commands
/menu — button menu
/mode — switch personality · /persona — create your own
/remember <fact> · /facts — what I know about you
/remind <text> · /reminders — your reminders (one-off or repeating)
/todo — your to-do list (tap to tick items off)
/briefing — daily morning briefing
/timezone <Area/City> — needed for reminders & briefing
/translate <language> <text> · /summarize · /fix
/reset — fresh chat · /me — your settings · /id

In groups, mention me (@username) or reply to one of my messages.`;

/* ----------------------------- keyboard helpers ----------------------------- */

/** rows = [[label, callbackData], ...][] -> InlineKeyboard (no empty rows). */
const kb = (rows) =>
  InlineKeyboard.from(rows.filter((r) => r.length).map((r) => r.map(([label, data]) => InlineKeyboard.text(label, data))));

const chunkRows = (buttons, n) => {
  const rows = [];
  for (let i = 0; i < buttons.length; i += n) rows.push(buttons.slice(i, i + n));
  return rows;
};

const BACK = [["⬅️ Menu", "menu:main"]];

const answerButtons = () => kb([[["🔄 Regenerate", "ai:regen"], ["✂️ Shorter", "ai:short"], ["🧹 New chat", "ai:reset"]]]);

const PERSONA_NAME = /^[a-z0-9_-]{1,20}$/;
const NEEDS_DB = "💾 This feature needs the database. Connect Upstash Redis (free): see the README, step “Add the database”.";

export function createBot(token) {
  const bot = new Bot(token);
  const store = createStore(token.split(":")[0]);
  bot.store = store; // used by the scheduler (server.js and api/cron.js)

  const allowed = (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  /* ----------------------------- small helpers ----------------------------- */

  const isPrivate = (ctx) => ctx.chat?.type === "private";

  // Groups: only react when mentioned or when someone replies to the bot.
  function shouldRespond(ctx) {
    if (isPrivate(ctx)) return true;
    const text = ctx.message?.text ?? ctx.message?.caption ?? "";
    const mentioned = text.toLowerCase().includes(`@${ctx.me.username.toLowerCase()}`);
    const repliedToMe = ctx.message?.reply_to_message?.from?.id === ctx.me.id;
    return mentioned || repliedToMe;
  }

  const cleanText = (ctx, text = "") => text.replace(new RegExp(`@${ctx.me.username}`, "gi"), "").trim();

  const replyOpts = (ctx) =>
    ctx.message && !isPrivate(ctx) ? { reply_parameters: { message_id: ctx.message.message_id } } : {};

  const repliedText = (ctx) =>
    ctx.message?.reply_to_message?.text ?? ctx.message?.reply_to_message?.caption ?? "";

  async function downloadFile(ctx, fileId) {
    const file = await ctx.api.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Send an AI answer; in private chats it gets Regenerate / Shorter / New chat buttons. */
  const replyAnswer = (ctx, text) =>
    replyLong(ctx, text, replyOpts(ctx), isPrivate(ctx) ? { reply_markup: answerButtons() } : {});

  // Optional protection for your free Gemini quota: DAILY_MESSAGE_LIMIT=50 caps AI requests per user per day.
  const DAILY_LIMIT = Number(process.env.DAILY_MESSAGE_LIMIT || 0);
  async function withinLimit(userId) {
    if (!DAILY_LIMIT) return true;
    return (await store.bumpUsage(userId)) <= DAILY_LIMIT;
  }
  const limitText = () => `📊 You've used your ${DAILY_LIMIT} AI messages for today. The counter resets at midnight UTC.`;

  /** Talk to Gemini with memory + tools and reply. */
  async function askAI(ctx, parts, historyNote) {
    if (!(await withinLimit(ctx.from.id))) return ctx.reply(limitText());
    await ctx.replyWithChatAction("typing");
    try {
      const answer = await chat({
        store,
        userId: ctx.from.id,
        chatId: ctx.chat.id,
        parts,
        historyNote,
        name: ctx.from.first_name,
      });
      await replyAnswer(ctx, answer);
    } catch (err) {
      console.error("[askAI]", err?.message ?? err);
      await ctx.reply(friendlyError(err));
    }
  }

  /** One-off AI task without memory (translate, summarize, fix). */
  async function runTask(ctx, instruction, text) {
    if (!(await withinLimit(ctx.from.id))) return ctx.reply(limitText());
    await ctx.replyWithChatAction("typing");
    try {
      await replyLong(ctx, await oneShot(instruction, text), replyOpts(ctx));
    } catch (err) {
      await ctx.reply(friendlyError(err));
    }
  }

  /* --------------------------------- views --------------------------------- */
  // A view = { text, kb }. Commands send them; button presses edit the message in place.

  const viewMain = () => ({
    text: "👻 PHANTOM AI — what would you like to do?",
    kb: kb([
      [["🎭 Personality", "menu:mode"], ["🧠 What I know about you", "menu:facts"]],
      [["⏰ Reminders", "menu:rem"], ["✅ To-do list", "menu:todo"]],
      [["🌅 Daily briefing", "menu:brief"]],
      [["🧹 New chat", "ai:reset"], ["❓ Help", "menu:help"]],
    ]),
  });

  const viewHelp = () => ({ text: HELP, kb: kb([BACK]) });

  async function viewMode(userId) {
    const p = await store.getProfile(userId);
    const active = resolvePersona(p).key;
    const entries = [
      ...Object.entries(MODES).map(([key, m]) => [key, m.label]),
      ...Object.keys(p.personas).map((key) => [key, `⭐ ${key}`]),
    ];
    const buttons = entries.map(([key, label]) => [`${key === active ? "✅ " : ""}${label}`, `mode:${key}`]);
    return {
      text:
        `🎭 Personality\nActive: ${active}\n\n` +
        `Create your own:\n/persona add pirate | You are a funny pirate. Answer in pirate speak.\n` +
        `Delete one: /persona delete pirate`,
      kb: kb([...chunkRows(buttons, 2), BACK]),
    };
  }

  async function viewFacts(userId) {
    const p = await store.getProfile(userId);
    if (!p.facts.length) {
      return {
        text:
          "🧠 I don't know anything about you yet.\n\nTell me things like “Remember that I'm vegetarian” " +
          "or use /remember <fact>.",
        kb: kb([BACK]),
      };
    }
    const list = p.facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
    const buttons = p.facts.slice(0, 20).map((_, i) => [`🗑 ${i + 1}`, `fact:del:${i}`]);
    return {
      text: `🧠 What I know about you:\n\n${list}\n\nTap a number to delete that fact.`,
      kb: kb([...chunkRows(buttons, 5), BACK]),
    };
  }

  async function viewReminders(userId) {
    if (!store.persistent) return { text: NEEDS_DB, kb: kb([BACK]) };
    const p = await store.getProfile(userId);
    const list = await store.listReminders(userId);
    if (!list.length) {
      return {
        text: "⏰ No reminders.\n\nTry: “Remind me tomorrow at 9am to call mum” or /remind in 30 minutes drink water.",
        kb: kb([BACK]),
      };
    }
    const lines = list
      .map((r, i) => `${i + 1}. ${formatLocal(r.dueAt, p.tz)} — ${r.text}${r.repeat ? ` 🔁 ${REPEAT_LABELS[r.repeat]}` : ""}`)
      .join("\n");
    const buttons = list.slice(0, 20).map((r, i) => [`❌ ${i + 1}`, `rem:del:${r.id}`]);
    return {
      text: `⏰ Your reminders (${p.tz}):\n\n${lines}\n\nTap a number to cancel it.`,
      kb: kb([...chunkRows(buttons, 5), BACK]),
    };
  }

  async function viewTodos(userId) {
    const { todos } = await store.getProfile(userId);
    if (!todos.length) {
      return {
        text: "✅ Your to-do list is empty.\n\nAdd things with /todo buy milk, or just say “add milk to my to-do list”.",
        kb: kb([BACK]),
      };
    }
    const list = todos.map((x, i) => `${x.done ? "✅" : "⬜"} ${i + 1}. ${x.t}`).join("\n");
    const buttons = todos.slice(0, 25).map((x, i) => [`${x.done ? "✅" : "⬜"} ${i + 1}`, `todo:tg:${i}`]);
    const hasDone = todos.some((x) => x.done);
    return {
      text: `✅ To-do list\n\n${list}\n\nTap a number to tick / untick it.`,
      kb: kb([...chunkRows(buttons, 5), [...(hasDone ? [["🧹 Clear done", "todo:clr"]] : []), ["⬅️ Menu", "menu:main"]]]),
    };
  }

  async function viewBriefing(userId) {
    if (!store.persistent) return { text: NEEDS_DB, kb: kb([BACK]) };
    const p = await store.getProfile(userId);
    const b = p.briefing;
    const hhmm = `${String(b.h).padStart(2, "0")}:${String(b.mi).padStart(2, "0")}`;
    const text =
      `🌅 Daily briefing: ${b.on ? "ON ✅" : "OFF"}\n` +
      `Time: ${hhmm} (${p.tz})${p.tzSet ? "" : "  ⚠️ time zone not set, send /timezone Continent/City"}\n` +
      `City (weather): ${b.city || "not set"}\n` +
      `News topics: ${b.topics.length ? b.topics.join(", ") : "top headlines"}\n\n` +
      `Change it:\n/briefing time 07:30\n/briefing city Paris\n/briefing topics tech, football\n` +
      `…or just say “send me a briefing every day at 7am”.`;
    return {
      text,
      kb: kb([[[b.on ? "⏸ Turn off" : "▶️ Turn on", "brief:toggle"], ["📨 Send now", "brief:now"]], BACK]),
    };
  }

  async function show(ctx, view) {
    try {
      await ctx.editMessageText(view.text, { reply_markup: view.kb, link_preview_options: { is_disabled: true } });
    } catch (err) {
      if (!/not modified/i.test(err?.description ?? err?.message ?? "")) {
        await ctx.reply(view.text, { reply_markup: view.kb, link_preview_options: { is_disabled: true } });
      }
    }
  }

  /* ------------------------ access control ----------------------- */

  bot.use(async (ctx, next) => {
    if (ctx.message?.text?.startsWith("/id")) return next(); // always allow, so you can find your ID
    if (allowed.length && !allowed.includes(String(ctx.from?.id))) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "🔒 Private bot", show_alert: true });
      else if (isPrivate(ctx)) await ctx.reply("🔒 This is a private bot.");
      return;
    }
    return next();
  });

  /* --------------------------- basic commands -------------------------- */

  bot.command("start", (ctx) =>
    ctx.reply(
      `👻 Hey ${ctx.from?.first_name ?? "there"}! I'm PHANTOM AI, powered by Google Gemini.\n\n` +
        `Ask me anything, send a photo, a voice note or a PDF. I can also check the weather, news and prices, ` +
        `set reminders, remember things about you and send you a daily briefing.\n\n` +
        `Tap /menu for buttons or /help for everything I can do.\n` +
        `First, set your time zone (for reminders): /timezone Europe/London`,
    ),
  );

  bot.command("help", (ctx) => ctx.reply(HELP));
  bot.command("menu", (ctx) => ctx.reply(viewMain().text, { reply_markup: viewMain().kb }));

  bot.command("id", (ctx) => ctx.reply(`🪪 Your user ID: ${ctx.from?.id}\n💬 This chat ID: ${ctx.chat.id}`));

  bot.command("reset", async (ctx) => {
    await store.clearHistory(ctx.chat.id);
    return ctx.reply("🧹 Fresh start! (I still remember the facts you saved. Manage them with /facts.)");
  });

  bot.command("time", async (ctx) => {
    const p = await store.getProfile(ctx.from.id);
    const tz = ctx.match.trim() || p.tz;
    if (!isValidTimeZone(tz)) return ctx.reply("Unknown time zone. Try /time Asia/Tokyo or /time America/New_York");
    const now = new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "medium" }).format(new Date());
    return ctx.reply(`🕒 ${tz}\n${now}`);
  });

  bot.command("me", async (ctx) => {
    const p = await store.getProfile(ctx.from.id);
    const rems = store.persistent ? (await store.listReminders(ctx.from.id)).length : "n/a";
    const b = p.briefing;
    return ctx.reply(
      `👤 ${p.name ?? ctx.from.first_name}\n` +
        `🌍 Time zone: ${p.tz}${p.tzSet ? "" : " (not set)"}\n` +
        `🎭 Personality: ${resolvePersona(p).key}\n` +
        `🧠 Saved facts: ${p.facts.length}\n` +
        `⏰ Reminders: ${rems}\n` +
        `✅ To-do items: ${p.todos.filter((x) => !x.done).length} open\n` +
        (DAILY_LIMIT ? `📊 AI messages today: ${await store.getUsage(ctx.from.id)} / ${DAILY_LIMIT}\n` : "") +
        `🌅 Briefing: ${b.on ? `on at ${String(b.h).padStart(2, "0")}:${String(b.mi).padStart(2, "0")}` : "off"}\n` +
        `💾 Storage: ${store.persistent ? "permanent (Upstash) ✅" : "temporary, RAM only ⚠️ (connect Upstash)"}`,
    );
  });

  /* ------------------------------ time zone ---------------------------- */

  bot.command("timezone", async (ctx) => {
    const arg = ctx.match.trim();
    const p = await store.getProfile(ctx.from.id);
    if (!arg) {
      return ctx.reply(
        `🌍 Your time zone: ${p.tz}${p.tzSet ? "" : " (not set yet)"}\n\n` +
          `Set it with /timezone Continent/City, for example:\n/timezone Africa/Lagos\n/timezone Europe/London\n` +
          `/timezone America/New_York\n\nOr just tell me where you live.`,
      );
    }
    if (!isValidTimeZone(arg)) {
      return ctx.reply("❓ I don't know that time zone. Use the form Continent/City, e.g. Europe/Paris or Asia/Dubai.");
    }
    const canonical = new Intl.DateTimeFormat("en", { timeZone: arg }).resolvedOptions().timeZone;
    await store.setTimezone(ctx.from.id, canonical);
    const now = new Intl.DateTimeFormat("en-GB", { timeZone: canonical, timeStyle: "short", dateStyle: "medium" }).format(new Date());
    return ctx.reply(`✅ Time zone set to ${canonical}. Your local time is ${now}.`);
  });

  /* ---------------------- personalities (modes/personas) --------------------- */

  bot.command("mode", async (ctx) => {
    const wanted = ctx.match.trim().toLowerCase();
    if (!wanted) {
      const v = await viewMode(ctx.from.id);
      return ctx.reply(v.text, { reply_markup: v.kb });
    }
    const p = await store.getProfile(ctx.from.id);
    if (!MODES[wanted] && !p.personas[wanted]) {
      return ctx.reply("I don't know that personality. Send /mode to see the buttons.");
    }
    p.mode = wanted;
    await store.saveProfile(ctx.from.id, p);
    return ctx.reply(`✅ Personality: ${wanted}`);
  });

  bot.command("persona", async (ctx) => {
    const arg = ctx.match.trim();
    const p = await store.getProfile(ctx.from.id);

    const add = arg.match(/^add\s+([^|]+)\|([\s\S]+)$/i);
    if (add) {
      const name = add[1].trim().toLowerCase().replace(/\s+/g, "-");
      const prompt = add[2].trim().slice(0, 1500);
      if (!PERSONA_NAME.test(name)) return ctx.reply("Name must be 1-20 characters: letters, numbers, - or _.");
      if (MODES[name]) return ctx.reply(`“${name}” is a built-in personality. Pick another name.`);
      if (!p.personas[name] && Object.keys(p.personas).length >= 10) return ctx.reply("You can have up to 10 custom personas. Delete one first.");
      p.personas[name] = prompt;
      p.mode = name;
      await store.saveProfile(ctx.from.id, p);
      return ctx.reply(`⭐ Persona “${name}” saved and activated. Switch any time with /mode.`);
    }

    const del = arg.match(/^(?:delete|remove)\s+(\S+)$/i);
    if (del) {
      const name = del[1].toLowerCase();
      if (!p.personas[name]) return ctx.reply("No custom persona with that name.");
      delete p.personas[name];
      if (p.mode === name) p.mode = "assistant";
      await store.saveProfile(ctx.from.id, p);
      return ctx.reply(`🗑 Persona “${name}” deleted.`);
    }

    const names = Object.keys(p.personas);
    return ctx.reply(
      `⭐ Your custom personas: ${names.length ? names.join(", ") : "none yet"}\n\n` +
        `Create:\n/persona add <name> | <instructions>\nExample:\n/persona add pirate | You are a funny pirate. Answer in pirate speak.\n\n` +
        `Delete: /persona delete <name>\nSwitch: /mode`,
    );
  });

  /* ------------------------------ saved facts ------------------------------ */

  bot.command("remember", async (ctx) => {
    const fact = ctx.match.trim() || repliedText(ctx);
    if (!fact) return ctx.reply("Usage: /remember <something about you>\nExample: /remember I'm vegetarian");
    const facts = await store.addFact(ctx.from.id, fact);
    return ctx.reply(`🧠 Saved! I now know ${facts.length} thing${facts.length === 1 ? "" : "s"} about you. See them with /facts.`);
  });

  bot.command("facts", async (ctx) => {
    const v = await viewFacts(ctx.from.id);
    return ctx.reply(v.text, { reply_markup: v.kb });
  });

  bot.command("forget", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    const p = await store.getProfile(ctx.from.id);
    if (arg === "all") {
      p.facts = [];
      await store.saveProfile(ctx.from.id, p);
      return ctx.reply("🗑 I forgot everything I knew about you.");
    }
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > p.facts.length) {
      return ctx.reply("Usage: /forget <number> or /forget all. See the numbers with /facts.");
    }
    const removed = await store.removeFact(ctx.from.id, n - 1);
    return ctx.reply(`🗑 Forgot: ${removed}`);
  });

  /* ------------------------------- reminders ------------------------------- */

  bot.command("remind", async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) {
      return ctx.reply("Usage: /remind <when and what>\nExamples:\n/remind in 30 minutes drink water\n/remind tomorrow 9am call mum");
    }
    if (!store.persistent) return ctx.reply(NEEDS_DB);
    return askAI(ctx, [{ text: `Set a reminder: ${arg}` }]);
  });

  bot.command("reminders", async (ctx) => {
    const v = await viewReminders(ctx.from.id);
    return ctx.reply(v.text, { reply_markup: v.kb });
  });

  /* -------------------------------- to-do list ------------------------------- */

  bot.command("todo", async (ctx) => {
    const arg = ctx.match.trim();
    const uid = ctx.from.id;
    const showList = async () => {
      const v = await viewTodos(uid);
      return ctx.reply(v.text, { reply_markup: v.kb });
    };
    try {
      if (!arg) return showList();

      const act = arg.match(/^(done|check|del|delete|remove)\s+(\d+)$/i);
      if (act) {
        const i = Number(act[2]) - 1;
        const isDone = /^(done|check)$/i.test(act[1]);
        const hit = isDone ? await store.setTodoDone(uid, i, true) : await store.removeTodo(uid, i);
        if (!hit) return ctx.reply("There's no item with that number. Send /todo to see the list.");
        return showList();
      }
      if (/^clear$/i.test(arg)) {
        const n = await store.clearDoneTodos(uid);
        await ctx.reply(`🧹 Removed ${n} finished item${n === 1 ? "" : "s"}.`);
        return showList();
      }
      await store.addTodo(uid, arg.replace(/^add\s+/i, ""));
      return showList();
    } catch (err) {
      return ctx.reply(`⚠️ ${err.message}`);
    }
  });

  /* ------------------------------ daily briefing ---------------------------- */

  bot.command("briefing", async (ctx) => {
    if (!store.persistent) return ctx.reply(NEEDS_DB);
    const arg = ctx.match.trim();
    const [sub = "", ...rest] = arg.split(/\s+/);
    const value = rest.join(" ").trim();
    const uid = ctx.from.id;

    try {
      switch (sub.toLowerCase()) {
        case "": {
          const v = await viewBriefing(uid);
          return ctx.reply(v.text, { reply_markup: v.kb });
        }
        case "on":
        case "off": {
          await store.configureBriefing(uid, { on: sub.toLowerCase() === "on" });
          const v = await viewBriefing(uid);
          return ctx.reply(v.text, { reply_markup: v.kb });
        }
        case "time": {
          const t = parseHHMM(value);
          if (!t) return ctx.reply("Use a time like 07:30 or 7am. Example: /briefing time 07:30");
          await store.configureBriefing(uid, { h: t.h, mi: t.mi, on: true });
          const v = await viewBriefing(uid);
          return ctx.reply(v.text, { reply_markup: v.kb });
        }
        case "city": {
          if (!value) return ctx.reply("Example: /briefing city Paris");
          await store.configureBriefing(uid, { city: value.slice(0, 80) });
          const v = await viewBriefing(uid);
          return ctx.reply(v.text, { reply_markup: v.kb });
        }
        case "topics": {
          const topics = value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5);
          await store.configureBriefing(uid, { topics });
          const v = await viewBriefing(uid);
          return ctx.reply(v.text, { reply_markup: v.kb });
        }
        case "now": {
          await ctx.replyWithChatAction("typing");
          const p = await store.getProfile(uid);
          return sendLongTo(ctx.api, ctx.chat.id, `🌅 ${await buildBriefing(store, uid, p)}`);
        }
        default:
          return ctx.reply("Try /briefing, /briefing on, /briefing off, /briefing time 07:30, /briefing city Paris, /briefing topics tech, football or /briefing now");
      }
    } catch (err) {
      console.error("[briefing]", err?.message ?? err);
      return ctx.reply(friendlyError(err));
    }
  });

  /* --------------------------- one-off AI commands --------------------------- */

  bot.command("translate", async (ctx) => {
    const arg = ctx.match.trim();
    const replied = repliedText(ctx);
    let lang;
    let text;

    if (replied && arg && !/\s/.test(arg)) {
      lang = arg;
      text = replied;
    } else {
      const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
      if (m) [, lang, text] = m;
    }

    if (!lang || !text) {
      return ctx.reply("Usage:\n/translate french Good morning\nor reply to any message with /translate spanish");
    }
    return runTask(
      ctx,
      `You are a professional translator. Translate the user's text into ${lang}. ` +
        `Keep the tone and formatting. Output ONLY the translation, nothing else.`,
      text,
    );
  });

  bot.command("summarize", async (ctx) => {
    const text = ctx.match.trim() || repliedText(ctx);
    if (!text) return ctx.reply("Usage: /summarize <text> — or reply to a message with /summarize");
    return runTask(
      ctx,
      "Summarize the user's text. Start with a one-line TL;DR, then up to 5 short bullet points with the key facts. " +
        "Use the same language as the text.",
      text,
    );
  });

  bot.command("fix", async (ctx) => {
    const text = ctx.match.trim() || repliedText(ctx);
    if (!text) return ctx.reply("Usage: /fix <text> — or reply to a message with /fix");
    return runTask(
      ctx,
      "Fix the grammar, spelling and punctuation of the user's text. Keep the meaning, tone and language. " +
        "Output ONLY the corrected text.",
      text,
    );
  });

  /* ------------------------------- button presses ---------------------------- */

  bot.on("callback_query:data", async (ctx) => {
    const [ns, a, b] = ctx.callbackQuery.data.split(":");
    const uid = ctx.from.id;
    const chatId = ctx.chat?.id ?? uid;
    const clearButtons = () => ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});

    try {
      /* ---- buttons under AI answers ---- */
      if (ns === "ai") {
        if (a === "reset") {
          await store.clearHistory(chatId);
          await ctx.answerCallbackQuery({ text: "🧹 Fresh chat" });
          await clearButtons();
          return;
        }
        if (!(await withinLimit(uid))) return ctx.answerCallbackQuery({ text: limitText(), show_alert: true });
        await ctx.answerCallbackQuery({ text: a === "regen" ? "🔄 Regenerating…" : "✂️ Shortening…" });
        await clearButtons();
        await ctx.replyWithChatAction("typing");
        const name = ctx.from.first_name;
        const answer =
          a === "regen"
            ? await regenerate({ store, userId: uid, chatId, name })
            : await chat({
                store, userId: uid, chatId, name,
                parts: [{ text: "Rewrite your previous answer much shorter, keeping only the essentials." }],
              });
        if (answer === null) return ctx.reply("I can only regenerate text answers. Please ask again.");
        return replyAnswer(ctx, answer);
      }

      /* ---- menus ---- */
      if (ns === "menu") {
        const views = { main: viewMain, help: viewHelp, mode: () => viewMode(uid), facts: () => viewFacts(uid), rem: () => viewReminders(uid), todo: () => viewTodos(uid), brief: () => viewBriefing(uid) };
        await ctx.answerCallbackQuery();
        return show(ctx, await (views[a] ?? viewMain)());
      }

      if (ns === "mode") {
        const p = await store.getProfile(uid);
        if (!MODES[a] && !p.personas[a]) return ctx.answerCallbackQuery({ text: "Unknown personality" });
        p.mode = a;
        await store.saveProfile(uid, p);
        await ctx.answerCallbackQuery({ text: `✅ ${a}` });
        return show(ctx, await viewMode(uid));
      }

      if (ns === "fact" && a === "del") {
        await store.removeFact(uid, Number(b));
        await ctx.answerCallbackQuery({ text: "🗑 Deleted" });
        return show(ctx, await viewFacts(uid));
      }

      if (ns === "todo") {
        if (a === "tg") await store.setTodoDone(uid, Number(b));
        else if (a === "clr") await store.clearDoneTodos(uid);
        await ctx.answerCallbackQuery();
        return show(ctx, await viewTodos(uid));
      }

      if (ns === "rem" && a === "del") {
        await store.cancelReminder(uid, b);
        await ctx.answerCallbackQuery({ text: "❌ Cancelled" });
        return show(ctx, await viewReminders(uid));
      }

      if (ns === "brief") {
        if (!store.persistent) return ctx.answerCallbackQuery({ text: "Connect Upstash first (see README)", show_alert: true });
        if (a === "toggle") {
          const p = await store.getProfile(uid);
          await store.configureBriefing(uid, { on: !p.briefing.on });
          await ctx.answerCallbackQuery({ text: p.briefing.on ? "⏸ Off" : "▶️ On" });
          return show(ctx, await viewBriefing(uid));
        }
        if (a === "now") {
          await ctx.answerCallbackQuery({ text: "📨 Preparing…" });
          await ctx.replyWithChatAction("typing");
          const p = await store.getProfile(uid);
          return sendLongTo(ctx.api, chatId, `🌅 ${await buildBriefing(store, uid, p)}`);
        }
      }

      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[callback]", err?.message ?? err);
      await ctx.answerCallbackQuery({ text: "Something went wrong" }).catch(() => {});
      await ctx.reply(friendlyError(err)).catch(() => {});
    }
  });

  /* ------------------------ normal messages ---------------------- */

  bot.on("message:text", async (ctx) => {
    const raw = ctx.message.text;

    if (raw.startsWith("/")) {
      if (isPrivate(ctx)) await ctx.reply("🤔 Unknown command. Try /help");
      return;
    }
    if (!shouldRespond(ctx)) return;

    const text = cleanText(ctx, raw);
    if (!text) return;

    // If the user replies to someone else's message, give Gemini that message as context.
    const quoted = repliedText(ctx);
    const repliedToMe = ctx.message.reply_to_message?.from?.id === ctx.me.id;
    const prompt =
      quoted && !repliedToMe ? `Context (the message I'm replying to):\n"""\n${quoted}\n"""\n\n${text}` : text;

    await askAI(ctx, [{ text: prompt }]);
  });

  // Photos, voice notes and files all go through the same path.
  async function handleMedia(ctx, { fileId, mimeType, size, defaultPrompt, label }) {
    if (!shouldRespond(ctx)) return;
    if (size && size > MAX_FILE_BYTES) {
      return ctx.reply("📦 That file is too big for me (limit is about 15 MB).");
    }

    await ctx.replyWithChatAction("typing");
    try {
      const buf = await downloadFile(ctx, fileId);
      const userText = cleanText(ctx, ctx.message.caption) || defaultPrompt;

      const filePart = mimeType.startsWith("text/")
        ? { text: `File content:\n${buf.toString("utf8").slice(0, 100_000)}` }
        : { inlineData: { mimeType, data: buf.toString("base64") } };

      await askAI(ctx, [filePart, { text: userText }], `[User sent ${label}] ${userText}`);
    } catch (err) {
      console.error("[media]", err);
      await ctx.reply(friendlyError(err));
    }
  }

  bot.on("message:photo", (ctx) =>
    handleMedia(ctx, {
      fileId: ctx.message.photo.at(-1).file_id, // biggest size
      size: ctx.message.photo.at(-1).file_size,
      mimeType: "image/jpeg",
      defaultPrompt: "Describe this image in detail and tell me anything interesting or useful about it.",
      label: "a photo",
    }),
  );

  bot.on("message:voice", (ctx) =>
    handleMedia(ctx, {
      fileId: ctx.message.voice.file_id,
      size: ctx.message.voice.file_size,
      mimeType: ctx.message.voice.mime_type || "audio/ogg",
      defaultPrompt: "Listen to this voice message and reply to it naturally, in the speaker's language.",
      label: "a voice message",
    }),
  );

  bot.on("message:document", (ctx) => {
    const doc = ctx.message.document;
    const mime = doc.mime_type || "";
    const ok = mime === "application/pdf" || mime.startsWith("image/") || mime.startsWith("text/");
    if (!ok) {
      return isPrivate(ctx) ? ctx.reply("📄 I can read PDFs, images and plain-text files.") : undefined;
    }
    return handleMedia(ctx, {
      fileId: doc.file_id,
      size: doc.file_size,
      mimeType: mime,
      defaultPrompt: "Summarize this file and point out the most important parts.",
      label: `a file (${doc.file_name ?? mime})`,
    });
  });

  bot.catch((err) => console.error("[bot] unhandled error:", err.error ?? err));

  return bot;
}

/* ------------------- webhook processing (shared) ------------------- */

const initialized = new WeakSet();
const seenUpdates = new Set(); // protects against Telegram re-delivering the same update

export async function processUpdate(bot, update) {
  if (!update || typeof update.update_id !== "number") return;

  if (seenUpdates.has(update.update_id)) return;
  seenUpdates.add(update.update_id);
  if (seenUpdates.size > 500) seenUpdates.delete(seenUpdates.values().next().value);

  if (!initialized.has(bot)) {
    await bot.init(); // fetches bot username etc. once
    initialized.add(bot);
  }
  await bot.handleUpdate(update);
}
