// src/scheduler.js — sends due reminders and daily briefings. Called once a minute (see README).
import { oneShot } from "./ai.js";
import { fetchWeather, fetchNews } from "./tools.js";
import { nextOccurrence, nextRepeat, formatLocal, REPEAT_LABELS } from "./timeutil.js";
import { sendLongTo } from "./format.js";

/* ------------------------------ daily briefing ------------------------------ */

export async function buildBriefing(store, userId, profile) {
  const b = profile.briefing;
  const tz = profile.tz;
  const today = new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "full" }).format(new Date());
  const data = [`Date: ${today}`, `User's name: ${profile.name ?? "(unknown)"}`];

  if (profile.facts?.length) data.push(`Things known about the user:\n${profile.facts.map((f) => `- ${f}`).join("\n")}`);

  if (b.city) {
    try {
      data.push(`Weather:\n${JSON.stringify(await fetchWeather(b.city))}`);
    } catch (err) {
      data.push(`Weather unavailable: ${err.message}`);
    }
  }

  const topics = b.topics?.length ? b.topics.slice(0, 3) : [null];
  const perTopic = b.topics?.length ? 3 : 5;
  const news = [];
  for (const topic of topics) {
    try {
      const items = await fetchNews(topic, perTopic);
      if (items.length) {
        news.push(
          `${topic ? `Topic: ${topic}` : "Top stories"}\n` +
            items.map((n) => `- [${n.title}](${n.link})${n.source ? ` (${n.source})` : ""}`).join("\n"),
        );
      }
    } catch (err) {
      news.push(`News unavailable for ${topic ?? "top stories"}: ${err.message}`);
    }
  }
  if (news.length) data.push(`News:\n${news.join("\n\n")}`);

  const reminders = (await store.listReminders(userId)).filter((r) => r.dueAt < Date.now() + 36 * 3_600_000);
  data.push(
    reminders.length
      ? `Upcoming reminders (next 36h):\n${reminders.map((r) => `- ${formatLocal(r.dueAt, tz)}: ${r.text}`).join("\n")}`
      : "Upcoming reminders: none",
  );

  const raw = data.join("\n\n");
  try {
    return await oneShot(
      "You write the user's daily morning briefing for Telegram. Warm, upbeat and compact. " +
        "Structure: a short greeting with their name and the date; weather in 1-2 lines with one practical tip (umbrella, jacket...); " +
        "the news as short bullet lines (keep each headline as the markdown link exactly as provided); today's reminders; " +
        "optionally one short, relevant motivating line. Use ONLY the data provided, never invent facts. " +
        "If a section says unavailable, skip it quietly. Use the user's language style: English.",
      raw,
    );
  } catch (err) {
    console.error("[briefing] Gemini failed, sending the raw data:", err?.message ?? err);
    return `🌅 Good morning!\n\n${raw}`;
  }
}

export async function sendBriefing(api, store, userId) {
  const profile = await store.getProfile(userId);
  if (!profile.briefing.on) return;
  // Schedule tomorrow FIRST so one failure never stops the daily briefing.
  await store.scheduleBriefing(userId, nextOccurrence(profile.briefing.h, profile.briefing.mi, profile.tz));
  const text = await buildBriefing(store, userId, profile);
  await sendLongTo(api, userId, `🌅 ${text}`);
}

/* ------------------------------- reminders -------------------------------- */

async function sendReminder(api, store, userId, id) {
  const r = await store.getReminder(userId, id);
  if (!r) return; // cancelled in the meantime

  let repeating = false;
  if (r.repeat) {
    // Schedule the next one FIRST so a failed send never ends the series.
    const { tz } = await store.getProfile(userId);
    const next = nextRepeat(r.dueAt, r.repeat, tz);
    if (next) {
      await store.rescheduleReminder(userId, r, next);
      repeating = true;
    }
  }
  await api.sendMessage(r.chatId, `⏰ Reminder${repeating ? ` 🔁 (${REPEAT_LABELS[r.repeat]})` : ""}\n\n${r.text}`);
  if (!repeating) await store.deleteReminderData(userId, id);
}

/* ------------------------------- the ticker ------------------------------- */

/** Process everything that is due right now. Safe to call from several places at once. */
export async function runDue(api, store) {
  if (!store.persistent) return 0;
  const items = await store.claimDue();
  for (const item of items) {
    const [kind, userId, id] = item.split("|");
    try {
      if (kind === "r") await sendReminder(api, store, userId, id);
      else if (kind === "b") await sendBriefing(api, store, userId);
    } catch (err) {
      console.error(`[scheduler] ${item} failed:`, err?.description ?? err?.message ?? err);
    }
  }
  return items.length;
}
