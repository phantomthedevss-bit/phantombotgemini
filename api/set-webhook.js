// api/set-webhook.js — VERCEL one-time setup.
// Open  https://<your-project>.vercel.app/api/set-webhook?key=<WEBHOOK_SECRET>  once after deploying.
import { Bot } from "grammy";
import { COMMANDS, ALLOWED_UPDATES } from "../src/bot.js";

export default async function handler(req, res) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.key !== secret) {
    return res.status(401).json({ ok: false, error: "Wrong or missing ?key= (use your WEBHOOK_SECRET)." });
  }
  if (!process.env.BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: "BOT_TOKEN is not set in Vercel environment variables." });
  }

  // Use the stable production domain (NOT the per-deployment URL, which can be password-protected).
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host;
  const url = `https://${host}/api/webhook`;

  try {
    const bot = new Bot(process.env.BOT_TOKEN);
    await bot.api.setWebhook(url, {
      secret_token: secret,
      allowed_updates: ALLOWED_UPDATES,
      drop_pending_updates: true,
    });
    await bot.api.setMyCommands(COMMANDS);
    const info = await bot.api.getWebhookInfo();
    return res.status(200).json({ ok: true, webhook: url, telegram_says: info });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
