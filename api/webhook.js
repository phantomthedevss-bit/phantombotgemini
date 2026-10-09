// api/webhook.js — VERCEL entry point (serverless function)
// Telegram sends every update here as a POST request.
import { createBot, processUpdate } from "../src/bot.js";

// Created once per warm instance and reused between requests.
const bot = createBot(process.env.BOT_TOKEN);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("PHANTOM AI (Vercel) webhook is alive 👻");
  }

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(401).send("Unauthorized");
  }

  try {
    // On Vercel we MUST finish the work before replying, otherwise the function is frozen.
    await processUpdate(bot, req.body);
  } catch (err) {
    console.error("❌ Update failed:", err);
  }
  // Always 200 so Telegram doesn't keep re-sending a failing update.
  return res.status(200).send("ok");
}
