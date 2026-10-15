// src/timeutil.js — time-zone maths without any extra library

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of a UTC timestamp in a given time zone. */
export function localParts(ts, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

function offsetMs(ts, tz) {
  const t = Math.floor(ts / 1000) * 1000;
  const p = localParts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
}

/** Convert a wall-clock time in `tz` to a UTC timestamp (ms). */
export function zonedToUtc(y, m, d, h, mi, tz) {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let ts = wall - offsetMs(wall, tz);
  ts = wall - offsetMs(ts, tz); // second pass handles daylight-saving edges
  return ts;
}

/** Next time (strictly after `now`) that the wall clock in `tz` shows hh:mm. */
export function nextOccurrence(hh, mm, tz, now = Date.now()) {
  const p = localParts(now, tz);
  let ts = zonedToUtc(p.y, p.m, p.d, hh, mm, tz);
  if (ts <= now) {
    const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    ts = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hh, mm, tz);
  }
  return ts;
}

/**
 * Next occurrence of a repeating reminder: the same wall-clock time on a later day,
 * strictly after `now` (missed runs, e.g. after an outage, are skipped, never sent in a burst).
 * repeat = "daily" | "weekly" | "weekdays" (Mon-Fri).
 */
export function nextRepeat(dueAt, repeat, tz, now = Date.now()) {
  const p = localParts(dueAt, tz);
  if (repeat === "yearly") {
    for (let k = 1; k < 60; k++) {
      const d = new Date(Date.UTC(p.y + k, p.m - 1, p.d)); // 29 Feb rolls to 1 Mar in non-leap years
      const ts = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), p.h, p.mi, tz);
      if (ts > now) return ts;
    }
    return null;
  }
  const step = repeat === "weekly" ? 7 : 1;
  let day = 0;
  for (let i = 0; i < 800; i++) {
    day += step;
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + day));
    if (repeat === "weekdays" && [0, 6].includes(d.getUTCDay())) continue;
    const ts = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), p.h, p.mi, tz);
    if (ts > now) return ts;
  }
  return null;
}

export const REPEAT_LABELS = { daily: "every day", weekly: "every week", weekdays: "every weekday", yearly: "every year" };
export const REPEATS = Object.keys(REPEAT_LABELS);

/** "2026-10-14" for the wall clock in tz. */
export function localDateKey(ts, tz) {
  const p = localParts(ts, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** UTC ms where "today" | "week" (Mon-start) | "month" | "all" begins in tz. */
export function periodStart(period, tz, now = Date.now()) {
  const p = localParts(now, tz);
  if (period === "today") return zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
  if (period === "month") return zonedToUtc(p.y, p.m, 1, 0, 0, tz);
  if (period === "week") {
    const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); // 0 = Sunday
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d - ((dow + 6) % 7)));
    return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, tz);
  }
  return 0;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** "25 Dec", "Dec 25", "25/12", "25-12" (day first) -> { d, m } or null */
export function parseDayMonth(str) {
  const s = String(str ?? "").trim().toLowerCase();
  let d, m;
  let r = s.match(/^(\d{1,2})[\s\/.-]+(\d{1,2})$/);
  if (r) [d, m] = [Number(r[1]), Number(r[2])];
  else if ((r = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})$/))) [d, m] = [Number(r[1]), MONTHS.indexOf(r[2].slice(0, 3)) + 1];
  else if ((r = s.match(/^([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?$/))) [d, m] = [Number(r[2]), MONTHS.indexOf(r[1].slice(0, 3)) + 1];
  else return null;
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= DAYS_IN[m - 1])) return null;
  return { d, m };
}

/** Parse "2026-10-12T09:30" (wall-clock in tz) -> UTC ms, or null. */
export function parseLocalDateTime(str, tz) {
  const m = String(str ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return zonedToUtc(y, mo, d, h, mi, tz);
}

export function formatLocal(ts, tz) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ts));
}

/** "2026-10-10T16:53" style string of the current wall clock in tz (for the AI prompt). */
export function nowLocalIso(tz, now = Date.now()) {
  const p = localParts(now, tz);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** "7:30", "07.30", "7pm", "19" -> { h, mi } or null */
export function parseHHMM(str) {
  const m = String(str ?? "").trim().match(/^(\d{1,2})(?::|\.|h)?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}
