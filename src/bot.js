// src/bot.js — the bot itself. Shared by BOTH the Render server and the Vercel function.
import { Bot } from "grammy";
import { chat, oneShot, resetSession, setMode, getMode, MODES, friendlyError } from "./ai.js";
import { replyLong } from "./format.js";

/** Shown in Telegram's "/" command menu (set automatically on startup / setup). */
export const COMMANDS = [
  { command: "start", description: "Wake up PHANTOM AI" },
  { command: "help", description: "What I can do" },
  { command: "mode", description: "Switch personality" },
  { command: "translate", description: "/translate french Good morning" },
  { command: "summarize", description: "Summarize text or a replied message" },
  { command: "fix", description: "Fix grammar and spelling" },
  { command: "reset", description: "Clear my memory of this chat" },
  { command: "time", description: "/time Asia/Tokyo" },
  { command: "id", description: "Show your Telegram ID" },
];

export const ALLOWED_UPDATES = ["message"];

const MAX_FILE_BYTES = 15 * 1024 * 1024;

const HELP = `👻 PHANTOM AI — what I can do

💬 Just talk to me — I remember the conversation.
🖼 Send a photo (add a caption with your question).
🎤 Send a voice message — I'll listen and answer.
📄 Send a PDF or .txt file — ask me about it.

Commands
/mode — switch personality (assistant, coder, teacher, concise)
/translate <language> <text> — or reply to a message with it
/summarize <text> — or reply to a message with it
/fix <text> — fix grammar & spelling
/reset — clear my memory of this chat
/time <Area/City> — current time anywhere
/id — show your Telegram user ID

In groups, mention me (@username) or reply to one of my messages.`;

export function createBot(token) {
  const bot = new Bot(token);

  const allowed = (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  /* --------------------------- helpers --------------------------- */

  const isPrivate = (ctx) => ctx.chat?.type === "private";

  // Groups: only react when mentioned or when someone replies to the bot.
  function shouldRespond(ctx) {
    if (isPrivate(ctx)) return true;
    const text = ctx.message?.text ?? ctx.message?.caption ?? "";
    const mentioned = text.toLowerCase().includes(`@${ctx.me.username.toLowerCase()}`);
    const repliedToMe = ctx.message?.reply_to_message?.from?.id === ctx.me.id;
    return mentioned || repliedToMe;
  }

  const cleanText = (ctx, text = "") =>
    text.replace(new RegExp(`@${ctx.me.username}`, "gi"), "").trim();

  const replyOpts = (ctx) =>
    isPrivate(ctx) ? {} : { reply_parameters: { message_id: ctx.message.message_id } };

  async function downloadFile(ctx, fileId) {
    const file = await ctx.api.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function runTask(ctx, instruction, text) {
    await ctx.replyWithChatAction("typing");
    try {
      const out = await oneShot(instruction, text);
      await replyLong(ctx, out, replyOpts(ctx));
    } catch (err) {
      await ctx.reply(friendlyError(err));
    }
  }

  const repliedText = (ctx) =>
    ctx.message?.reply_to_message?.text ?? ctx.message?.reply_to_message?.caption ?? "";

  /* ------------------------ access control ----------------------- */

  bot.use(async (ctx, next) => {
    if (ctx.message?.text?.startsWith("/id")) return next(); // always allow, so you can find your ID
    if (allowed.length && !allowed.includes(String(ctx.from?.id))) {
      if (isPrivate(ctx)) await ctx.reply("🔒 This is a private bot.");
      return;
    }
    return next();
  });

  /* --------------------------- commands -------------------------- */

  bot.command("start", (ctx) =>
    ctx.reply(
      `👻 Hey ${ctx.from?.first_name ?? "there"}! I'm PHANTOM AI, powered by Google Gemini.\n\n` +
        `Ask me anything, send me a photo, a voice note or a PDF.\nType /help to see everything I can do.`,
    ),
  );

  bot.command("help", (ctx) => ctx.reply(HELP));

  bot.command("id", (ctx) =>
    ctx.reply(`🪪 Your user ID: ${ctx.from?.id}\n💬 This chat ID: ${ctx.chat.id}`),
  );

  bot.command("reset", (ctx) => {
    resetSession(ctx.chat.id);
    return ctx.reply("🧹 Memory cleared. Fresh start!");
  });

  bot.command("mode", (ctx) => {
    const wanted = ctx.match.trim().toLowerCase();
    if (wanted && setMode(ctx.chat.id, wanted)) {
      return ctx.reply(`✅ Mode: ${wanted} — ${MODES[wanted].label}`);
    }
    const list = Object.entries(MODES)
      .map(([key, m]) => `• ${key} — ${m.label}`)
      .join("\n");
    return ctx.reply(`Current mode: ${getMode(ctx.chat.id)}\n\nAvailable:\n${list}\n\nUse: /mode coder`);
  });

  bot.command("time", async (ctx) => {
    const tz = ctx.match.trim() || "UTC";
    try {
      const now = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        dateStyle: "full",
        timeStyle: "medium",
      }).format(new Date());
      await ctx.reply(`🕒 ${tz}\n${now}`);
    } catch {
      await ctx.reply("Unknown time zone. Try /time Asia/Tokyo or /time America/New_York");
    }
  });

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
      return ctx.reply(
        "Usage:\n/translate french Good morning\nor reply to any message with /translate spanish",
      );
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

    await ctx.replyWithChatAction("typing");
    try {
      const answer = await chat(ctx.chat.id, [{ text: prompt }]);
      await replyLong(ctx, answer, replyOpts(ctx));
    } catch (err) {
      await ctx.reply(friendlyError(err));
    }
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

      const answer = await chat(ctx.chat.id, [filePart, { text: userText }], `[User sent ${label}] ${userText}`);
      await replyLong(ctx, answer, replyOpts(ctx));
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
