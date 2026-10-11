// api/cron.js — VERCEL scheduler endpoint.
// An outside timer (cron-job.org, free) opens  https://<project>.vercel.app/api/cron?key=<CRON_SECRET or WEBHOOK_SECRET>
// every minute. Each call sends whatever reminders / daily briefings are due.
import { createBot } from "../src/bot.js";
import { runDue } from "../src/scheduler.js";

const bot = createBot(process.env.BOT_TOKEN);

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || process.env.WEBHOOK_SECRET;
  // Accepts ?key=... (cron-job.org) or "Authorization: Bearer ..." (Vercel's own cron).
  const given = req.query.key ?? req.headers.authorization?.replace(/^Bearer /i, "");
  if (!secret || given !== secret) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const processed = await runDue(bot.api, bot.store);
    return res.status(200).json({ ok: true, processed, database: bot.store.persistent });
  } catch (err) {
    console.error("❌ Cron failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
