// src/features.js — notes, expenses and habits. Pure logic on top of store documents.
// Shared by the slash commands (extras.js) and the AI tools (tools.js), so both behave the same.
import { localDateKey, periodStart } from "./timeutil.js";

const newId = () => Math.random().toString(36).slice(2, 8);

/* ----------------------------------- notes ----------------------------------- */

export const MAX_NOTES = 300;

export const listNotes = async (store, uid) => (await store.getDoc("notes", uid)) ?? [];

export async function addNote(store, uid, text) {
  const t = String(text).trim().slice(0, 1000);
  if (!t) throw new Error("The note is empty.");
  const notes = await listNotes(store, uid);
  const note = { id: newId(), t, at: Date.now() };
  notes.push(note);
  await store.setDoc("notes", uid, notes.slice(-MAX_NOTES));
  return note;
}

const words = (s) => String(s ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

/** Notes matching the query (best match first). Empty query = the 10 newest. */
export async function searchNotes(store, uid, query) {
  const notes = await listNotes(store, uid);
  const q = words(query);
  if (!q.length) return notes.slice(-10).reverse();
  return notes
    .map((n) => {
      const hay = n.t.toLowerCase();
      return { n, score: q.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.n.at - a.n.at)
    .slice(0, 10)
    .map((x) => x.n);
}

/** Delete by id, or the first note containing the text. Returns the deleted note or null. */
export async function deleteNote(store, uid, ref) {
  const notes = await listNotes(store, uid);
  const needle = String(ref).toLowerCase();
  const i = notes.findIndex((n) => n.id === ref) >= 0 ? notes.findIndex((n) => n.id === ref) : notes.findIndex((n) => n.t.toLowerCase().includes(needle));
  if (i < 0) return null;
  const [removed] = notes.splice(i, 1);
  await store.setDoc("notes", uid, notes);
  return removed;
}

/* --------------------------------- expenses ---------------------------------- */

export const MAX_EXPENSES = 2000;

export const CATEGORY_LABELS = {
  food: "🍽 Food",
  transport: "🚕 Transport",
  data: "📱 Airtime & data",
  bills: "🧾 Bills & rent",
  shopping: "🛍 Shopping",
  health: "💊 Health",
  fun: "🎉 Fun",
  other: "📦 Other",
};

const CATEGORY_WORDS = [
  ["food", /food|lunch|dinner|breakfast|eat|restaurant|snack|rice|chicken|pizza|drink|coffee|grocer|market|shawarma|bread|suya|meal|jollof|buka|beans|fish|meat|water/],
  ["transport", /transport|uber|bolt|taxi|bus|fuel|petrol|diesel|keke|okada|fare|ride|train|flight|parking/],
  ["data", /data|airtime|recharge|wifi|internet|subscription|netflix|spotify|mtn|glo|airtel|youtube/],
  ["bills", /bill|electric|nepa|light|rent|tax|dstv|gotv|insurance|fees|loan|levy/],
  ["shopping", /shop|cloth|shoe|bag|mall|jumia|amazon|gift|wear|phone|laptop|dress|jeans/],
  ["health", /health|hospital|medic|drug|pharmac|doctor|clinic|gym|dental/],
  ["fun", /movie|cinema|game|party|club|concert|outing|bet|fun|show|ticket/],
];

export function categorize(text) {
  const t = String(text ?? "").toLowerCase();
  return CATEGORY_WORDS.find(([, re]) => re.test(t))?.[0] ?? "other";
}

/** "5000", "5,000", "5k", "1.5k", "2m", "₦5000" -> number, or null */
export function parseAmount(str) {
  const m = String(str ?? "").trim().replace(/^[₦$£€]\s*/, "").match(/^(\d[\d,]*(?:\.\d+)?)\s*(k|m)?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * ({ k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] ?? 1);
  return n > 0 && n < 1e12 ? n : null;
}

export function fmtMoney(n, currency = "") {
  const s = Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (!currency) return s;
  return /^[A-Za-z]{2,}$/.test(currency) ? `${s} ${currency}` : `${currency}${s}`;
}

export const listExpenses = async (store, uid) => (await store.getDoc("expenses", uid)) ?? [];

export async function addExpense(store, uid, { amount, text, category, at = Date.now() }) {
  const a = typeof amount === "number" ? amount : parseAmount(amount);
  if (!a || a <= 0) throw new Error("I need a positive amount.");
  const desc = String(text ?? "").trim().slice(0, 120) || "expense";
  const cat = CATEGORY_LABELS[category] ? category : categorize(`${desc} ${category ?? ""}`);
  const list = await listExpenses(store, uid);
  const item = { id: newId(), a, c: cat, t: desc, at };
  list.push(item);
  await store.setDoc("expenses", uid, list.slice(-MAX_EXPENSES));
  return item;
}

export async function deleteExpense(store, uid, id) {
  const list = await listExpenses(store, uid);
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const [removed] = list.splice(i, 1);
  await store.setDoc("expenses", uid, list);
  return removed;
}

/** period: "today" | "week" | "month" | "all" */
export async function summarizeExpenses(store, uid, period, tz, now = Date.now()) {
  const from = periodStart(period, tz, now);
  const items = (await listExpenses(store, uid)).filter((e) => e.at >= from).sort((a, b) => b.at - a.at);
  const byCat = {};
  let total = 0;
  for (const e of items) {
    total += e.a;
    byCat[e.c] = (byCat[e.c] ?? 0) + e.a;
  }
  return {
    period,
    total,
    count: items.length,
    byCategory: Object.entries(byCat).sort((a, b) => b[1] - a[1]),
    recent: items.slice(0, 8),
  };
}

/** ▇▇▇▇▁▁▁▁ style bar for a fraction 0..1 */
export const bar = (fraction, width = 10) => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "▇".repeat(filled) + "▁".repeat(width - filled);
};

/* ----------------------------------- habits ---------------------------------- */

export const MAX_HABITS = 15;
const KEEP_DAYS = 120;

export const listHabits = async (store, uid) => (await store.getDoc("habits", uid)) ?? [];

export async function addHabit(store, uid, name) {
  const n = String(name).trim().slice(0, 60);
  if (!n) throw new Error("The habit needs a name.");
  const list = await listHabits(store, uid);
  if (list.some((h) => h.n.toLowerCase() === n.toLowerCase())) throw new Error(`You already track “${n}”.`);
  if (list.length >= MAX_HABITS) throw new Error(`You can track up to ${MAX_HABITS} habits.`);
  const habit = { id: newId(), n, days: [] };
  list.push(habit);
  await store.setDoc("habits", uid, list);
  return habit;
}

export async function removeHabit(store, uid, index) {
  const list = await listHabits(store, uid);
  const [removed] = list.splice(index, 1);
  if (removed) await store.setDoc("habits", uid, list);
  return removed ?? null;
}

/** "2026-10-14" shifted by n days */
export function shiftKey(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Consecutive days ending today (or yesterday, if today isn't ticked yet). */
export function streakOf(days, todayKey) {
  const set = new Set(days);
  let key = set.has(todayKey) ? todayKey : shiftKey(todayKey, -1);
  let n = 0;
  while (set.has(key)) {
    n++;
    key = shiftKey(key, -1);
  }
  return n;
}

export function weekDots(days, todayKey) {
  const set = new Set(days);
  return Array.from({ length: 7 }, (_, i) => (set.has(shiftKey(todayKey, i - 6)) ? "✅" : "⬜")).join("");
}

/** ref = 1-based number or part of the name. Returns { habit, already, streak } or null. */
export async function checkHabit(store, uid, ref, tz, now = Date.now()) {
  const list = await listHabits(store, uid);
  const n = Number(ref);
  const habit = Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : list.find((h) => h.n.toLowerCase().includes(String(ref).toLowerCase()));
  if (!habit) return null;
  const today = localDateKey(now, tz);
  const already = habit.days.includes(today);
  if (!already) habit.days = [...habit.days, today].sort().slice(-KEEP_DAYS);
  await store.setDoc("habits", uid, list);
  return { habit, already, streak: streakOf(habit.days, today) };
}

/* ------------------------- price alerts & page watches ------------------------ */
// Both are "scheduled items": the minute timer checks them when their time comes (see scheduler.js).

export const ALERT_INTERVAL = 5 * 60_000; // price alerts are checked every 5 minutes
export const WATCH_INTERVAL = 30 * 60_000; // watched pages every 30 minutes
export const ALERT_LIFETIME = 90 * 86_400_000; // alerts expire after 90 days
export const MAX_ALERTS = 10;
export const MAX_WATCHES = 5;

export const listAlerts = async (store, uid) => (await store.getDoc("alerts", uid)) ?? [];

export async function addAlert(store, uid, { asset, dir, target, chatId }) {
  const list = await listAlerts(store, uid);
  if (list.length >= MAX_ALERTS) throw new Error(`You can have up to ${MAX_ALERTS} price alerts. Cancel one first.`);
  const alert = { id: newId(), asset, dir, target, chatId, at: Date.now() };
  list.push(alert);
  await store.setDoc("alerts", uid, list);
  await store.scheduleItem(`a|${uid}|${alert.id}`, Date.now() + ALERT_INTERVAL);
  return alert;
}

export async function removeAlert(store, uid, id) {
  const list = await listAlerts(store, uid);
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return null;
  const [removed] = list.splice(i, 1);
  await store.setDoc("alerts", uid, list);
  await store.unscheduleItem(`a|${uid}|${id}`);
  return removed;
}

export const listWatches = async (store, uid) => (await store.getDoc("watches", uid)) ?? [];

export async function addWatch(store, uid, { url, chatId, hash, text }) {
  const list = await listWatches(store, uid);
  if (list.length >= MAX_WATCHES) throw new Error(`You can watch up to ${MAX_WATCHES} pages. Stop one first.`);
  if (list.some((w) => w.url === url)) throw new Error("You're already watching that page.");
  const watch = { id: newId(), url, chatId, hash, text: String(text).slice(0, 6000), fails: 0, at: Date.now() };
  list.push(watch);
  await store.setDoc("watches", uid, list);
  await store.scheduleItem(`w|${uid}|${watch.id}`, Date.now() + WATCH_INTERVAL);
  return watch;
}

export async function removeWatch(store, uid, id) {
  const list = await listWatches(store, uid);
  const i = list.findIndex((w) => w.id === id);
  if (i < 0) return null;
  const [removed] = list.splice(i, 1);
  await store.setDoc("watches", uid, list);
  await store.unscheduleItem(`w|${uid}|${id}`);
  return removed;
}

/** Does the current price satisfy the alert? */
export const alertHit = (alert, price) => (alert.dir === "above" ? price >= alert.target : price <= alert.target);
