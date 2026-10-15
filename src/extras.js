// src/extras.js — views for notes, expenses, habits, price alerts and page watches.
// Pure view-builders on top of features.js, shared by commands and buttons in bot.js.
import { kb, chunkRows, BACK } from "./kb.js";
import { formatLocal, localDateKey } from "./timeutil.js";
import {
  listNotes, searchNotes, deleteNote,
  listExpenses, summarizeExpenses, fmtMoney, CATEGORY_LABELS, bar,
  listHabits, streakOf, weekDots,
  listAlerts, listWatches,
} from "./features.js";

/* ------------------------------------ notes ------------------------------------ */

export async function viewNotes(store, uid) {
  const notes = await listNotes(store, uid);
  if (!notes.length) {
    return { text: "📝 No notes yet.\n\nSave one with /note <text>, or just say “note this: …”.", kb: kb([BACK]) };
  }
  const recent = notes.slice(-10).reverse();
  const list = recent.map((n, i) => `${i + 1}. ${n.t.length > 80 ? n.t.slice(0, 77) + "…" : n.t}`).join("\n");
  const buttons = recent.map((n, i) => [`🗑 ${i + 1}`, `note:del:${n.id}`]);
  return {
    text: `📝 Your notes (${notes.length} total, newest first):\n\n${list}\n\n/note <text> to add · /findnote <word> to search`,
    kb: kb([...chunkRows(buttons, 5), BACK]),
  };
}

export async function viewNoteSearch(store, uid, query) {
  const notes = await searchNotes(store, uid, query);
  if (!notes.length) return { text: `📝 No notes match "${query}".`, kb: kb([BACK]) };
  const list = notes.map((n, i) => `${i + 1}. ${n.t}`).join("\n");
  const buttons = notes.map((n, i) => [`🗑 ${i + 1}`, `note:del:${n.id}`]);
  return { text: `📝 Matches for "${query}":\n\n${list}`, kb: kb([...chunkRows(buttons, 5), BACK]) };
}

/* --------------------------------- expenses --------------------------------- */

export async function viewExpenses(store, uid, profile, period = "month") {
  const sum = await summarizeExpenses(store, uid, period, profile.tz);
  const cur = profile.currency;
  const PERIOD_LABEL = { today: "Today", week: "This week", month: "This month", all: "All time" };
  if (!sum.count) {
    return {
      text: `💰 ${PERIOD_LABEL[period]}: nothing logged yet.\n\nTry /spent 5000 lunch, or just say “I spent 2k on transport”.`,
      kb: kb([[["📅 Today", "exp:p:today"], ["📅 Week", "exp:p:week"], ["📅 All", "exp:p:all"]], BACK]),
    };
  }
  const lines = sum.byCategory.map(([c, t]) => {
    const pct = t / sum.total;
    return `${CATEGORY_LABELS[c] ?? c}\n${bar(pct)} ${fmtMoney(t, cur)} (${Math.round(pct * 100)}%)`;
  });
  const budgetLine =
    period === "month" && profile.budget
      ? `\n\n🎯 Budget: ${fmtMoney(sum.total, cur)} / ${fmtMoney(profile.budget, cur)} ${bar(sum.total / profile.budget, 12)}` +
        (sum.total > profile.budget ? " ⚠️ over budget" : "")
      : "";
  const recent = sum.recent.slice(0, 5).map((e) => `• ${e.t} — ${fmtMoney(e.a, cur)}`).join("\n");
  return {
    text:
      `💰 ${PERIOD_LABEL[period]}: *${fmtMoney(sum.total, cur)}* across ${sum.count} item${sum.count === 1 ? "" : "s"}\n\n` +
      `${lines.join("\n\n")}${budgetLine}\n\nRecent:\n${recent}`,
    kb: kb([[["📅 Today", "exp:p:today"], ["📅 Week", "exp:p:week"], ["📅 Month", "exp:p:month"], ["📅 All", "exp:p:all"]], BACK]),
  };
}

/* ----------------------------------- habits ---------------------------------- */

export async function viewHabits(store, uid, tz) {
  const habits = await listHabits(store, uid);
  if (!habits.length) {
    return { text: "🔁 No habits tracked yet.\n\nStart one: /habit add Drink water", kb: kb([BACK]) };
  }
  const today = localDateKey(Date.now(), tz);
  const lines = habits.map((h, i) => {
    const done = h.days.includes(today);
    const streak = streakOf(h.days, today);
    return `${i + 1}. ${done ? "✅" : "⬜"} *${h.n}* — 🔥${streak}d\n${weekDots(h.days, today)}`;
  });
  const buttons = habits.map((h, i) => [`${h.days.includes(today) ? "✅" : "⬜"} ${i + 1}`, `habit:tg:${i + 1}`]);
  return {
    text: `🔁 Your habits:\n\n${lines.join("\n\n")}\n\nTap a number to mark today done.\n/habit add <name> · /habit del <number>`,
    kb: kb([...chunkRows(buttons, 5), BACK]),
  };
}

/* ------------------------------- alerts & watches ------------------------------- */

export async function viewAlerts(store, uid) {
  const alerts = await listAlerts(store, uid);
  if (!alerts.length) {
    return { text: "🔔 No price alerts.\n\nTry: “tell me when bitcoin goes above 70000”.", kb: kb([BACK]) };
  }
  const list = alerts.map((a, i) => `${i + 1}. ${a.asset.toUpperCase()} ${a.dir} ${a.target}`).join("\n");
  const buttons = alerts.map((a, i) => [`❌ ${i + 1}`, `alert:del:${a.id}`]);
  return { text: `🔔 Price alerts:\n\n${list}\n\nChecked every 5 minutes.`, kb: kb([...chunkRows(buttons, 5), BACK]) };
}

export async function viewWatches(store, uid) {
  const watches = await listWatches(store, uid);
  if (!watches.length) {
    return { text: "👀 Not watching any pages.\n\nTry: “watch this page and tell me if it changes” + a link.", kb: kb([BACK]) };
  }
  const list = watches.map((w, i) => `${i + 1}. ${w.url}`).join("\n");
  const buttons = watches.map((w, i) => [`❌ ${i + 1}`, `watch:del:${w.id}`]);
  return { text: `👀 Watched pages:\n\n${list}\n\nChecked every 30 minutes.`, kb: kb([...chunkRows(buttons, 5), BACK]) };
}
