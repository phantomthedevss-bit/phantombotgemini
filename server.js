// server.js — RENDER entry point (long-running web service)
//
// - On Render it runs in WEBHOOK mode and registers the webhook automatically
//   using the RENDER_EXTERNAL_URL that Render provides.
// - On your own computer (no public URL) it falls back to POLLING so you can test locally.
import express from "express";
import { createBot, processUpdate, COMMANDS, ALLOWED_UPDATES } from "./src/bot.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("❌ BOT_TOKEN is missing. Add it in your environment variables.");
  process.exit(1);
}

const secret = process.env.WEBHOOK_SECRET || undefined;
const baseUrl = (process.env.WEBHOOK_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const port = Number(process.env.PORT) || 3000;

const bot = createBot(token);
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.send("PHANTOM AI (Render) is running 👻"));
app.get("/health", (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

app.post("/webhook", (req, res) => {
  if (secret && req.get("x-telegram-bot-api-secret-token") !== secret) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // answer Telegram immediately, process in the background
  processUpdate(bot, req.body).catch((err) => console.error("❌ Update failed:", err));
});

app.listen(port, async () => {
  console.log(`🚀 PHANTOM AI listening on port ${port}`);

  try {
    await bot.api.setMyCommands(COMMANDS);
  } catch (err) {
    console.error("Could not set the command menu:", err.message);
  }

  if (baseUrl) {
    if (!secret) console.warn("⚠️  WEBHOOK_SECRET is not set — anyone could POST fake updates to your webhook.");
    try {
      await bot.api.setWebhook(`${baseUrl}/webhook`, {
        secret_token: secret,
        allowed_updates: ALLOWED_UPDATES,
      });
      console.log(`✅ Webhook set: ${baseUrl}/webhook`);
    } catch (err) {
      console.error("❌ Could not set the webhook:", err.message);
    }
  } else {
    console.log("ℹ️  No public URL found → starting in long-polling mode (local testing).");
    bot.start({ allowed_updates: ALLOWED_UPDATES }).catch((err) => console.error("Polling stopped:", err));
  }
});
