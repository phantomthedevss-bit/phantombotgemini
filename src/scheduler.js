// src/scheduler.js — sends due reminders and daily briefings. Called once a minute (see README).
import { createHash } from "node:crypto";
import { oneShot, runScheduledPrompt } from "./ai.js";
import { fetchWeather, fetchNews, getAssetPrice, readUrl } from "./tools.js";
import { listAlerts, removeAlert, listWatches, removeWatch, alertHit, ALERT_INTERVAL, WATCH_INTERVAL, ALERT_LIFETIME } from "./features.js";
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
  const tag = repeating ? ` 🔁 (${REPEAT_LABELS[r.repeat]})` : "";
  if (r.ai) {
    // A scheduled AI message: Gemini writes it right now (read-only tools).
    let text;
    try {
      text = await runScheduledPrompt({ store, userId, chatId: r.chatId, prompt: r.text });
    } catch (err) {
      console.error("[scheduler] AI message failed:", err?.message ?? err);
      text = `(I couldn't write this one: ${r.text})`;
    }
    await sendLongTo(api, r.chatId, `🤖 Scheduled${tag}\n\n${text}`);
  } else {
    await api.sendMessage(r.chatId, `⏰ Reminder${tag}\n\n${r.text}`);
  }
  if (!repeating) await store.deleteReminderData(userId, id);
}

/* ----------------------------- price alerts ------------------------------- */

async function checkAlert(api, store, userId, id) {
  const alert = (await listAlerts(store, userId)).find((a) => a.id === id);
  if (!alert) return; // cancelled
  if (Date.now() - alert.at > ALERT_LIFETIME) {
    await removeAlert(store, userId, id);
    await api.sendMessage(alert.chatId, `⌛ Your price alert for ${alert.asset} (${alert.dir} ${alert.target}) expired after 90 days.`);
    return;
  }
  await store.scheduleItem(`a|${userId}|${id}`, Date.now() + ALERT_INTERVAL); // next check first
  const now = await getAssetPrice(alert.asset);
  if (!alertHit(alert, now.price)) return;
  await removeAlert(store, userId, id);
  await api.sendMessage(
    alert.chatId,
    `🔔 Price alert: ${now.label} is now ${now.price} ${now.unit}`.trim() + `\n(You asked to be told when it went ${alert.dir} ${alert.target}.)`,
  );
}

/* ------------------------------ page watches ------------------------------ */

async function checkWatch(api, store, userId, id) {
  const w = (await listWatches(store, userId)).find((x) => x.id === id);
  if (!w) return;
  await store.scheduleItem(`w|${userId}|${id}`, Date.now() + WATCH_INTERVAL);
  let page;
  try {
    page = await readUrl(w.url);
  } catch (err) {
    // Give up quietly after several failures in a row (site down / removed).
    const list = await listWatches(store, userId);
    const cur = list.find((x) => x.id === id);
    if (cur && ++cur.fails >= 6) {
      await removeWatch(store, userId, id);
      await api.sendMessage(w.chatId, `👀 I stopped watching ${w.url} because I couldn't open it several times in a row.`);
    } else if (cur) await store.setDoc("watches", userId, list);
    return;
  }
  const hash = createHash("sha1").update(page.text).digest("hex");
  const list = await listWatches(store, userId);
  const cur = list.find((x) => x.id === id);
  if (!cur) return;
  cur.fails = 0;
  if (hash === cur.hash) return void (await store.setDoc("watches", userId, list));

  // Changed: show what's new (lines that weren't there before), best effort.
  const before = new Set(cur.text.split("\n").map((l) => l.trim()));
  const fresh = page.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 3 && !before.has(l)).slice(0, 8);
  cur.hash = hash;
  cur.text = page.text.slice(0, 6000);
  await store.setDoc("watches", userId, list);
  await api.sendMessage(
    w.chatId,
    `👀 This page changed:\n${w.url}` + (fresh.length ? `\n\nNew:\n${fresh.map((l) => `• ${l.slice(0, 160)}`).join("\n")}` : ""),
    { link_preview_options: { is_disabled: true } },
  );
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
      else if (kind === "a") await checkAlert(api, store, userId, id);
      else if (kind === "w") await checkWatch(api, store, userId, id);
    } catch (err) {
      console.error(`[scheduler] ${item} failed:`, err?.description ?? err?.message ?? err);
    }
  }
  return items.length;
}
