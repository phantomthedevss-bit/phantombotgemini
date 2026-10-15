// src/tools.js — everything Gemini is allowed to DO (function calling).
// Each tool = a declaration (what Gemini sees) + a run() function (what we execute).
// All the data tools use free APIs that need no key.
import { Type } from "@google/genai";
import { createHash } from "node:crypto";
import { parseLocalDateTime, formatLocal, isValidTimeZone, REPEAT_LABELS, REPEATS, localDateKey } from "./timeutil.js";
import {
  addNote, searchNotes, deleteNote,
  addExpense, summarizeExpenses, fmtMoney, CATEGORY_LABELS,
  addHabit, listHabits, checkHabit, streakOf,
  addAlert, listAlerts, removeAlert, addWatch, listWatches, removeWatch,
} from "./features.js";

const UA = "PhantomAIBot/2.0 (Telegram assistant)";
const TIMEOUT = 10_000;

async function getJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`The service answered HTTP ${res.status}`);
  return res.json();
}

/* --------------------------------- weather --------------------------------- */

const WMO = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light rain showers", 81: "rain showers", 82: "violent rain showers", 85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

export async function fetchWeather(city) {
  const geo = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
  );
  const place = geo.results?.[0];
  if (!place) throw new Error(`I couldn't find a place called "${city}".`);

  const w = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&forecast_days=3`,
  );
  const c = w.current;
  const d = w.daily;
  return {
    place: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
    now: {
      conditions: WMO[c.weather_code] ?? "unknown",
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_percent: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
    },
    forecast: d.time.map((date, i) => ({
      date,
      conditions: WMO[d.weather_code[i]] ?? "unknown",
      min_c: d.temperature_2m_min[i],
      max_c: d.temperature_2m_max[i],
      rain_chance_percent: d.precipitation_probability_max[i],
    })),
  };
}

/* ----------------------------------- news ---------------------------------- */

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const xmlTag = (s, tag) =>
  decodeEntities(
    (s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
  );

export async function fetchNews(topic, limit = 6) {
  const gl = (process.env.NEWS_COUNTRY || "US").toUpperCase();
  const q = topic ? `search?q=${encodeURIComponent(topic)}&` : "?";
  const res = await fetch(`https://news.google.com/rss/${q}hl=en&gl=${gl}&ceid=${gl}:en`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`News service answered HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map((m) => ({
    title: xmlTag(m[1], "title"),
    source: xmlTag(m[1], "source"),
    link: xmlTag(m[1], "link"),
  }));
}

/* ------------------------------ read a web page ----------------------------- */

function isBlockedHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || /\.(local|localhost|internal|lan)$/.test(h)) return true;
  if (h.includes(":")) return h === "::1" || /^(fe80|fc|fd|::ffff)/.test(h);
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  return false;
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n\s*\n+/g, "\n\n"),
  ).trim();
}

export async function readUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:$/.test(url.protocol) || isBlockedHost(url.hostname)) {
      throw new Error("I'm not allowed to open that address.");
    }
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url);
      continue;
    }
    if (!res.ok) throw new Error(`The page answered HTTP ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml/i.test(type)) throw new Error(`I can only read text pages (this one is ${type || "unknown"}).`);
    if (Number(res.headers.get("content-length") ?? 0) > 3_000_000) throw new Error("That page is too large.");
    const body = await res.text();
    const text = /html/i.test(type) ? htmlToText(body) : body;
    return { url: url.href, text: text.slice(0, 12_000), truncated: text.length > 12_000 };
  }
  throw new Error("Too many redirects.");
}

/* --------------------------------- calculator ------------------------------- */

export function calculate(expression) {
  const e = String(expression)
    .replace(/\s+/g, "")
    .replace(/[×x]/g, "*")
    .replace(/÷/g, "/")
    .replace(/\^/g, "**")
    .replace(/,/g, "")
    .replace(/(\d+(?:\.\d+)?)%of(\d+(?:\.\d+)?)/gi, "($1/100*$2)"); // "15% of 2000"
  if (!/^[0-9+\-*/%().]+$/.test(e)) throw new Error("Only numbers and + - * / % ^ ( ) are allowed.");
  const value = Function(`"use strict"; return (${e});`)();
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("That doesn't give a finite number.");
  return value;
}

/* --------------------------------- crypto ids ------------------------------- */

const COIN_ALIASES = {
  btc: "bitcoin", eth: "ethereum", sol: "solana", bnb: "binancecoin", xrp: "ripple", ada: "cardano",
  doge: "dogecoin", ton: "the-open-network", trx: "tron", dot: "polkadot", matic: "polygon-ecosystem-token",
  pol: "polygon-ecosystem-token", ltc: "litecoin", usdt: "tether", usdc: "usd-coin", shib: "shiba-inu",
  avax: "avalanche-2", link: "chainlink",
};

const COIN_IDS = new Set(Object.values(COIN_ALIASES));
export const isCoin = (s) => {
  const x = String(s).toLowerCase();
  return x in COIN_ALIASES || COIN_IDS.has(x);
};

/**
 * Current price of an asset. "btc" / "bitcoin" / "eth/ngn" = crypto (in USD unless a currency is given),
 * "usd/ngn" = a currency pair. Returns { price, label, unit }.
 */
export async function getAssetPrice(asset) {
  const [left, right] = String(asset).trim().split("/").map((x) => x.trim());
  if (!left) throw new Error("Which asset?");

  if (right && !isCoin(left) && /^[a-z]{3}$/i.test(left) && /^[a-z]{3}$/i.test(right)) {
    const f = left.toUpperCase();
    const t = right.toUpperCase();
    const data = await getJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(f)}`);
    const rate = data.rates?.[t];
    if (data.result !== "success" || !rate) throw new Error(`I don't have a rate for ${f}/${t}.`);
    return { price: rate, label: `${f}/${t}`, unit: "" };
  }

  const id = COIN_ALIASES[left.toLowerCase()] ?? left.toLowerCase().replace(/\s+/g, "-");
  const cur = (right || "usd").toLowerCase();
  const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${cur}`);
  if (data[id]?.[cur] === undefined) throw new Error(`I couldn't find a price for "${asset}" (try the full coin name).`);
  return { price: data[id][cur], label: left.toUpperCase().length <= 5 ? left.toUpperCase() : id, unit: cur.toUpperCase() };
}

/* ---------------------------------- helpers --------------------------------- */

const needDb = (env) =>
  env.store.persistent
    ? null
    : "The bot has no database connected yet, so this isn't available. Tell the user to connect Upstash Redis (see the README).";

const str = (description) => ({ type: Type.STRING, description });
const obj = (properties, required = []) => ({ type: Type.OBJECT, properties, required });

/** Shared by set_reminder and schedule_ai_message. */
async function makeReminder({ text, in_minutes, datetime_local, repeat }, env, extra = {}) {
  const blocked = needDb(env);
  if (blocked) return { error: blocked };
  const tz = env.profile.tz;
  let dueAt;
  if (typeof in_minutes === "number" && in_minutes > 0) dueAt = Date.now() + Math.round(in_minutes * 60_000);
  else dueAt = parseLocalDateTime(datetime_local, tz);
  if (!dueAt) return { error: "I need either in_minutes or datetime_local (YYYY-MM-DDTHH:MM)." };
  if (dueAt < Date.now() - 30_000) return { error: "That time is already in the past. Ask the user for a future time." };
  if (dueAt > Date.now() + 366 * 86_400_000) return { error: "The first send can be at most one year ahead." };

  const rep = REPEATS.includes(repeat) ? repeat : undefined;
  const id = await env.store.addReminder({
    userId: env.userId,
    chatId: env.chatId,
    text: String(text).slice(0, 500),
    dueAt,
    repeat: rep,
    ...extra,
  });
  return {
    ok: true,
    id,
    repeats: rep ? REPEAT_LABELS[rep] : "no (one time)",
    will_fire_at: formatLocal(dueAt, tz),
    timezone: tz,
    note: env.profile.tzSet ? undefined : "The user hasn't set a time zone yet, so UTC was assumed. Tell them to send /timezone Continent/City.",
  };
}

/* ----------------------------------- tools ---------------------------------- */

const TOOLS = {
  get_weather: {
    declaration: {
      name: "get_weather",
      description: "Get the current weather and a 3-day forecast for a city.",
      parameters: obj({ city: str("City name, e.g. 'Lagos' or 'Paris'") }, ["city"]),
    },
    run: ({ city }) => fetchWeather(city),
  },

  get_news: {
    declaration: {
      name: "get_news",
      description: "Get the latest news headlines, either top stories or about a topic.",
      parameters: obj({ topic: str("Optional topic, e.g. 'football', 'AI', 'Nigeria economy'. Omit for top stories.") }),
    },
    run: async ({ topic }) => ({ headlines: await fetchNews(topic) }),
  },

  get_crypto_price: {
    declaration: {
      name: "get_crypto_price",
      description: "Get the current price and 24h change of a cryptocurrency.",
      parameters: obj(
        {
          coin: str("Coin name or symbol, e.g. 'bitcoin', 'btc', 'ethereum'"),
          currency: str("Fiat currency code, e.g. 'usd', 'ngn', 'eur'. Default usd."),
        },
        ["coin"],
      ),
    },
    run: async ({ coin, currency = "usd" }) => {
      const id = COIN_ALIASES[String(coin).toLowerCase()] ?? String(coin).toLowerCase().replace(/\s+/g, "-");
      const cur = String(currency).toLowerCase();
      const data = await getJson(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${cur}&include_24hr_change=true`,
      );
      if (!data[id]) throw new Error(`I couldn't find a coin called "${coin}" (try its full name).`);
      return { coin: id, currency: cur, price: data[id][cur], change_24h_percent: data[id][`${cur}_24h_change`] };
    },
  },

  convert_currency: {
    declaration: {
      name: "convert_currency",
      description: "Convert an amount between two currencies using today's exchange rates.",
      parameters: obj(
        {
          amount: { type: Type.NUMBER, description: "Amount to convert" },
          from: str("Source currency code, e.g. 'USD'"),
          to: str("Target currency code, e.g. 'NGN'"),
        },
        ["amount", "from", "to"],
      ),
    },
    run: async ({ amount, from, to }) => {
      const f = String(from).toUpperCase();
      const t = String(to).toUpperCase();
      const data = await getJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(f)}`);
      const rate = data.rates?.[t];
      if (data.result !== "success" || !rate) throw new Error(`I don't have a rate for ${f} to ${t}.`);
      return { amount, from: f, to: t, rate, result: amount * rate, rates_updated: data.time_last_update_utc };
    },
  },

  wikipedia: {
    declaration: {
      name: "wikipedia",
      description: "Look up a short, reliable summary of a person, place, concept or event on Wikipedia.",
      parameters: obj({ topic: str("What to look up") }, ["topic"]),
    },
    run: async ({ topic }) => {
      const s = await getJson(
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(topic)}&limit=1&namespace=0&format=json`,
      );
      const title = s?.[1]?.[0];
      if (!title) throw new Error(`Wikipedia has nothing for "${topic}".`);
      const sum = await getJson(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      );
      return { title: sum.title, summary: sum.extract, url: sum.content_urls?.desktop?.page };
    },
  },

  calculator: {
    declaration: {
      name: "calculator",
      description: "Evaluate an arithmetic expression exactly. Use this for any non-trivial maths.",
      parameters: obj({ expression: str("e.g. '(1250 * 12) / 7 + 3^2'") }, ["expression"]),
    },
    run: ({ expression }) => ({ expression, result: calculate(expression) }),
  },

  get_time: {
    declaration: {
      name: "get_time",
      description: "Get the current date and time in any IANA time zone.",
      parameters: obj({ timezone: str("IANA zone such as 'Asia/Tokyo' or 'America/New_York'") }, ["timezone"]),
    },
    run: ({ timezone }) => {
      if (!isValidTimeZone(timezone)) throw new Error(`"${timezone}" isn't a valid IANA time zone.`);
      return {
        timezone,
        now: new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "full", timeStyle: "medium" }).format(new Date()),
      };
    },
  },

  read_webpage: {
    declaration: {
      name: "read_webpage",
      description: "Open a web page the user gave you and read its text (for summarising or answering questions about it).",
      parameters: obj({ url: str("Full http(s) URL") }, ["url"]),
    },
    run: ({ url }) => readUrl(url),
  },

  web_search: {
    optional: () => !!process.env.TAVILY_API_KEY,
    declaration: {
      name: "web_search",
      description: "Search the live web for up-to-date information and get an answer plus sources.",
      parameters: obj({ query: str("Search query") }, ["query"]),
    },
    run: async ({ query }) => {
      const data = await getJson("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
        body: JSON.stringify({ query, max_results: 5, include_answer: true }),
      });
      return {
        answer: data.answer,
        results: (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: String(r.content ?? "").slice(0, 400) })),
      };
    },
  },

  /* ------------------------------ about the user ------------------------------ */

  save_fact: {
    declaration: {
      name: "save_fact",
      description:
        "Save a lasting fact about the user (name, job, preferences, allergies, goals...) so you remember it in future chats. " +
        "Call it when the user asks you to remember something or shares an important personal detail.",
      parameters: obj({ fact: str("A short, self-contained sentence, e.g. 'Is allergic to peanuts'") }, ["fact"]),
    },
    run: async ({ fact }, env) => {
      const facts = await env.store.addFact(env.userId, fact);
      return { saved: true, total_facts: facts.length, note: env.store.persistent ? undefined : "Stored temporarily only (no database)." };
    },
  },

  forget_fact: {
    declaration: {
      name: "forget_fact",
      description: "Delete saved facts about the user that contain the given text.",
      parameters: obj({ contains: str("Text that identifies the fact(s) to delete") }, ["contains"]),
    },
    run: async ({ contains }, env) => {
      const profile = await env.store.getProfile(env.userId);
      const needle = String(contains).toLowerCase();
      const keep = profile.facts.filter((f) => !f.toLowerCase().includes(needle));
      const removed = profile.facts.length - keep.length;
      if (removed) {
        profile.facts = keep;
        await env.store.saveProfile(env.userId, profile);
      }
      return { removed };
    },
  },

  set_timezone: {
    declaration: {
      name: "set_timezone",
      description: "Save the user's time zone (needed for correct reminders and the daily briefing). Use when they say where they live.",
      parameters: obj({ timezone: str("IANA zone, e.g. 'Africa/Nairobi', 'Europe/London', 'America/Chicago'") }, ["timezone"]),
    },
    run: async ({ timezone }, env) => {
      if (!isValidTimeZone(timezone)) throw new Error(`"${timezone}" isn't a valid IANA time zone.`);
      await env.store.setTimezone(env.userId, timezone);
      return { timezone };
    },
  },

  /* -------------------------------- reminders -------------------------------- */

  set_reminder: {
    declaration: {
      name: "set_reminder",
      description:
        "Schedule a reminder that the bot will send to the user later. For relative times ('in 20 minutes', 'in 2 hours') use in_minutes. " +
        "For clock times ('tomorrow 9am', 'Friday 18:30') use datetime_local, calculated from the user's current local time.",
      parameters: obj(
        {
          text: str("What to remind the user about, phrased as the message they will receive"),
          in_minutes: { type: Type.NUMBER, description: "Minutes from now (for relative times)" },
          datetime_local: str("Local date-time in the USER's time zone, format YYYY-MM-DDTHH:MM (24h)"),
          repeat: {
            type: Type.STRING,
            enum: REPEATS,
            description:
              "Only for repeating reminders. 'daily' = every day, 'weekdays' = Monday to Friday, 'weekly' = same weekday every week, " +
              "'yearly' = every year (birthdays, anniversaries). datetime_local must then be the FIRST occurrence " +
              "(e.g. for 'every Monday 8am', the next Monday 08:00; for a birthday on 25 Dec, the next 25 Dec at 08:00).",
          },
        },
        ["text"],
      ),
    },
    run: (args, env) => makeReminder(args, env),
  },

  schedule_ai_message: {
    declaration: {
      name: "schedule_ai_message",
      description:
        "Schedule a message that the AI WRITES fresh each time it is sent (e.g. 'every morning at 6 send me a motivational quote', " +
        "'every Friday summarise tech news', 'daily at 8pm tell me the bitcoin price'). The prompt is what the AI will be asked at send time. " +
        "Use set_reminder instead for fixed text.",
      parameters: obj(
        {
          prompt: str("Instruction for the AI at send time, e.g. 'Give me a short motivational quote and a one-line fitness tip'"),
          in_minutes: { type: Type.NUMBER, description: "Minutes from now (first send)" },
          datetime_local: str("First send, local date-time in the USER's time zone, YYYY-MM-DDTHH:MM (24h)"),
          repeat: { type: Type.STRING, enum: REPEATS, description: "Omit for a one-time message" },
        },
        ["prompt"],
      ),
    },
    run: ({ prompt, ...rest }, env) => makeReminder({ text: prompt, ...rest }, env, { ai: true }),
  },

  list_reminders: {
    declaration: {
      name: "list_reminders",
      description: "List the user's pending reminders.",
      parameters: obj({}),
    },
    run: async (_args, env) => {
      const blocked = needDb(env);
      if (blocked) return { error: blocked };
      const list = await env.store.listReminders(env.userId);
      return {
        reminders: list.map((r) => ({
          id: r.id,
          text: r.text,
          next: formatLocal(r.dueAt, env.profile.tz),
          repeats: r.repeat ? REPEAT_LABELS[r.repeat] : "no",
        })),
      };
    },
  },

  cancel_reminder: {
    declaration: {
      name: "cancel_reminder",
      description: "Cancel a pending reminder by its id (get ids from list_reminders).",
      parameters: obj({ id: str("Reminder id") }, ["id"]),
    },
    run: async ({ id }, env) => {
      const blocked = needDb(env);
      if (blocked) return { error: blocked };
      return { cancelled: await env.store.cancelReminder(env.userId, String(id)) };
    },
  },

  /* --------------------------------- to-do list -------------------------------- */

  add_todo: {
    declaration: {
      name: "add_todo",
      description: "Add an item to the user's to-do list (a task with no specific time; for timed things use set_reminder).",
      parameters: obj({ task: str("The task, e.g. 'Buy milk'") }, ["task"]),
    },
    run: async ({ task }, env) => {
      const todos = await env.store.addTodo(env.userId, task);
      return { added: true, open_items: todos.filter((x) => !x.done).length };
    },
  },

  list_todos: {
    declaration: {
      name: "list_todos",
      description: "Show the user's to-do list.",
      parameters: obj({}),
    },
    run: async (_args, env) => {
      const p = await env.store.getProfile(env.userId);
      return { todos: p.todos.map((x, i) => ({ number: i + 1, task: x.t, done: x.done })) };
    },
  },

  complete_todo: {
    declaration: {
      name: "complete_todo",
      description: "Mark a to-do item as done, by its number or by text it contains.",
      parameters: obj({ number: { type: Type.NUMBER, description: "Item number from list_todos" }, contains: str("Text that identifies the item") }),
    },
    run: async ({ number, contains }, env) => {
      const p = await env.store.getProfile(env.userId);
      let i = Number.isInteger(number) ? number - 1 : p.todos.findIndex((x) => !x.done && x.t.toLowerCase().includes(String(contains ?? "").toLowerCase()));
      if (i < 0 || i >= p.todos.length || (!Number.isInteger(number) && !contains)) return { error: "I couldn't find that to-do item." };
      const item = await env.store.setTodoDone(env.userId, i, true);
      return { done: item.t };
    },
  },

  delete_todo: {
    declaration: {
      name: "delete_todo",
      description: "Delete a to-do item by its number or by text it contains.",
      parameters: obj({ number: { type: Type.NUMBER, description: "Item number from list_todos" }, contains: str("Text that identifies the item") }),
    },
    run: async ({ number, contains }, env) => {
      const p = await env.store.getProfile(env.userId);
      let i = Number.isInteger(number) ? number - 1 : p.todos.findIndex((x) => x.t.toLowerCase().includes(String(contains ?? "").toLowerCase()));
      if (i < 0 || i >= p.todos.length || (!Number.isInteger(number) && !contains)) return { error: "I couldn't find that to-do item." };
      const removed = await env.store.removeTodo(env.userId, i);
      return { deleted: removed.t };
    },
  },

  /* ----------------------------------- notes ----------------------------------- */

  save_note: {
    declaration: {
      name: "save_note",
      description: "Save a note, idea, link or snippet for the user to find later. Use when they say 'note this', 'save this', 'jot down'.",
      parameters: obj({ text: str("The note, kept close to the user's own words") }, ["text"]),
    },
    run: async ({ text }, env) => {
      const n = await addNote(env.store, env.userId, text);
      return { saved: true, id: n.id };
    },
  },

  search_notes: {
    declaration: {
      name: "search_notes",
      description: "Find the user's saved notes. Leave the query empty to get the newest ones.",
      parameters: obj({ query: str("Words to look for") }),
    },
    run: async ({ query }, env) => {
      const notes = await searchNotes(env.store, env.userId, query);
      return { count: notes.length, notes: notes.map((n) => ({ id: n.id, text: n.t, saved: formatLocal(n.at, env.profile.tz) })) };
    },
  },

  delete_note: {
    declaration: {
      name: "delete_note",
      description: "Delete a saved note by id, or the first note containing the given text.",
      parameters: obj({ ref: str("Note id, or text the note contains") }, ["ref"]),
    },
    run: async ({ ref }, env) => {
      const n = await deleteNote(env.store, env.userId, ref);
      return n ? { deleted: n.t } : { error: "No matching note." };
    },
  },

  /* --------------------------------- expenses --------------------------------- */

  log_expense: {
    declaration: {
      name: "log_expense",
      description:
        "Record money the user spent. Also use it when the user sends a photo of a RECEIPT: read the total (and what it was for) and log it.",
      parameters: obj(
        {
          amount: { type: Type.NUMBER, description: "Amount spent, as a plain number (5k = 5000)" },
          description: str("What it was for, e.g. 'lunch at Mama Put'"),
          category: { type: Type.STRING, enum: Object.keys(CATEGORY_LABELS), description: "Best matching category" },
        },
        ["amount", "description"],
      ),
    },
    run: async ({ amount, description, category }, env) => {
      const e = await addExpense(env.store, env.userId, { amount, text: description, category });
      const sum = await summarizeExpenses(env.store, env.userId, "today", env.profile.tz);
      return { logged: true, id: e.id, category: e.c, spent_today: fmtMoney(sum.total, env.profile.currency) };
    },
  },

  expense_summary: {
    declaration: {
      name: "expense_summary",
      description: "Summarise the user's spending for a period, with a breakdown by category.",
      parameters: obj({ period: { type: Type.STRING, enum: ["today", "week", "month", "all"], description: "Default month" } }),
    },
    run: async ({ period = "month" }, env) => {
      const sum = await summarizeExpenses(env.store, env.userId, period, env.profile.tz);
      const cur = env.profile.currency;
      return {
        period,
        total: fmtMoney(sum.total, cur),
        transactions: sum.count,
        by_category: sum.byCategory.map(([c, t]) => ({ category: CATEGORY_LABELS[c] ?? c, total: fmtMoney(t, cur) })),
        monthly_budget: period === "month" && env.profile.budget ? fmtMoney(env.profile.budget, cur) : undefined,
        recent: sum.recent.slice(0, 5).map((x) => ({ what: x.t, amount: fmtMoney(x.a, cur) })),
      };
    },
  },

  configure_money: {
    declaration: {
      name: "configure_money",
      description: "Set the currency label shown with expenses (e.g. '₦', 'NGN', '$') and/or the user's monthly spending budget.",
      parameters: obj({
        currency: str("Currency symbol or code"),
        monthly_budget: { type: Type.NUMBER, description: "Monthly budget amount; 0 removes it" },
      }),
    },
    run: async ({ currency, monthly_budget }, env) => {
      const p = await env.store.getProfile(env.userId);
      if (typeof currency === "string") p.currency = currency.trim().slice(0, 5);
      if (typeof monthly_budget === "number" && monthly_budget >= 0) p.budget = monthly_budget;
      await env.store.saveProfile(env.userId, p);
      return { currency: p.currency, monthly_budget: p.budget };
    },
  },

  /* ----------------------------------- habits ---------------------------------- */

  add_habit: {
    declaration: {
      name: "add_habit",
      description: "Start tracking a daily habit for the user (e.g. 'Drink water', 'Read 10 pages', 'Gym').",
      parameters: obj({ name: str("Habit name") }, ["name"]),
    },
    run: async ({ name }, env) => ({ added: (await addHabit(env.store, env.userId, name)).n }),
  },

  check_habit: {
    declaration: {
      name: "check_habit",
      description: "Mark a habit as done today (by name or number). Use when the user says they did it.",
      parameters: obj({ habit: str("Habit name (or part of it) or its number") }, ["habit"]),
    },
    run: async ({ habit }, env) => {
      const r = await checkHabit(env.store, env.userId, habit, env.profile.tz);
      if (!r) return { error: "I couldn't find that habit. Use list_habits." };
      return { habit: r.habit.n, already_done_today: r.already, streak_days: r.streak };
    },
  },

  list_habits: {
    declaration: { name: "list_habits", description: "List the user's habits with today's status and streaks.", parameters: obj({}) },
    run: async (_a, env) => {
      const today = localDateKey(Date.now(), env.profile.tz);
      const list = await listHabits(env.store, env.userId);
      return { habits: list.map((h, i) => ({ number: i + 1, name: h.n, done_today: h.days.includes(today), streak_days: streakOf(h.days, today) })) };
    },
  },

  /* ------------------------------- price alerts ------------------------------- */

  set_price_alert: {
    declaration: {
      name: "set_price_alert",
      description:
        "Notify the user when a crypto price or exchange rate crosses a level. Checked every 5 minutes. " +
        "asset: a coin ('bitcoin', 'btc', 'eth', optionally 'btc/ngn' for another currency) or a currency pair ('usd/ngn').",
      parameters: obj(
        {
          asset: str("e.g. 'btc', 'ethereum', 'usd/ngn'"),
          direction: { type: Type.STRING, enum: ["above", "below"], description: "Alert when the price goes above or below the target" },
          target: { type: Type.NUMBER, description: "Target price / rate" },
        },
        ["asset", "direction", "target"],
      ),
    },
    run: async ({ asset, direction, target }, env) => {
      const blocked = needDb(env);
      if (blocked) return { error: blocked };
      if (!(target > 0) || !["above", "below"].includes(direction)) return { error: "I need a direction (above/below) and a positive target." };
      const now = await getAssetPrice(asset); // also proves the asset exists
      const already = direction === "above" ? now.price >= target : now.price <= target;
      if (already) return { error: `It's already ${direction} that level (now ${now.price} ${now.unit}). Ask for a different target.` };
      const a = await addAlert(env.store, env.userId, { asset, dir: direction, target, chatId: env.chatId });
      return { ok: true, id: a.id, asset: now.label, current_price: `${now.price} ${now.unit}`.trim(), will_alert_when: `${direction} ${target}` };
    },
  },

  list_price_alerts: {
    declaration: { name: "list_price_alerts", description: "List the user's active price alerts.", parameters: obj({}) },
    run: async (_a, env) => ({ alerts: (await listAlerts(env.store, env.userId)).map((a) => ({ id: a.id, asset: a.asset, when: `${a.dir} ${a.target}` })) }),
  },

  cancel_price_alert: {
    declaration: {
      name: "cancel_price_alert",
      description: "Cancel a price alert by id (see list_price_alerts).",
      parameters: obj({ id: str("Alert id") }, ["id"]),
    },
    run: async ({ id }, env) => ({ cancelled: !!(await removeAlert(env.store, env.userId, String(id))) }),
  },

  /* ------------------------------- page watching ------------------------------- */

  watch_page: {
    declaration: {
      name: "watch_page",
      description:
        "Watch a web page and notify the user when its content changes (checked every 30 minutes). Works best on simple, mostly static pages.",
      parameters: obj({ url: str("Full http(s) URL") }, ["url"]),
    },
    run: async ({ url }, env) => {
      const blocked = needDb(env);
      if (blocked) return { error: blocked };
      const page = await readUrl(url); // also validates the address
      const hash = createHash("sha1").update(page.text).digest("hex");
      const w = await addWatch(env.store, env.userId, { url: page.url, chatId: env.chatId, hash, text: page.text });
      return { ok: true, id: w.id, watching: page.url, checks: "every 30 minutes" };
    },
  },

  list_watched_pages: {
    declaration: { name: "list_watched_pages", description: "List the pages the user is watching.", parameters: obj({}) },
    run: async (_a, env) => ({ pages: (await listWatches(env.store, env.userId)).map((w) => ({ id: w.id, url: w.url })) }),
  },

  stop_watching: {
    declaration: {
      name: "stop_watching",
      description: "Stop watching a page by id (see list_watched_pages).",
      parameters: obj({ id: str("Watch id") }, ["id"]),
    },
    run: async ({ id }, env) => ({ stopped: !!(await removeWatch(env.store, env.userId, String(id))) }),
  },

  /* ------------------------------ daily briefing ------------------------------ */

  configure_briefing: {
    declaration: {
      name: "configure_briefing",
      description:
        "Turn the user's daily morning briefing on or off, or change it. The briefing is a message sent every day with weather, news and their reminders.",
      parameters: obj({
        enabled: { type: Type.BOOLEAN, description: "true to turn on, false to turn off" },
        time: str("Time of day in 24h HH:MM, e.g. '07:30'"),
        city: str("City for the weather section"),
        topics: { type: Type.ARRAY, items: { type: Type.STRING }, description: "News topics, e.g. ['tech', 'football']" },
      }),
    },
    run: async ({ enabled, time, city, topics }, env) => {
      const blocked = needDb(env);
      if (blocked) return { error: blocked };
      const patch = {};
      if (typeof enabled === "boolean") patch.on = enabled;
      if (time) {
        const m = String(time).match(/^(\d{1,2}):(\d{2})$/);
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { error: "time must look like 07:30" };
        patch.h = Number(m[1]);
        patch.mi = Number(m[2]);
      }
      if (city) patch.city = String(city).slice(0, 80);
      if (Array.isArray(topics)) patch.topics = topics.map(String).slice(0, 5);
      if (patch.on === undefined && Object.keys(patch).length) patch.on = true; // setting details implies "on"
      const p = await env.store.configureBriefing(env.userId, patch);
      const b = p.briefing;
      return {
        enabled: b.on,
        time: `${String(b.h).padStart(2, "0")}:${String(b.mi).padStart(2, "0")}`,
        timezone: p.tz,
        city: b.city,
        topics: b.topics,
        note: p.tzSet ? undefined : "No time zone set yet (UTC assumed). Tell the user to send /timezone Continent/City.",
      };
    },
  },
};

/** What Gemini is told it can call. */
// Scheduled AI messages run unattended, so they may only READ data (never change settings or schedule more things).
const READ_ONLY = new Set([
  "get_weather", "get_news", "get_crypto_price", "convert_currency", "wikipedia", "calculator", "get_time", "read_webpage", "web_search",
  "search_notes", "expense_summary", "list_habits", "list_todos", "list_reminders",
]);

export function toolDeclarations(env) {
  return Object.entries(TOOLS)
    .filter(([name, t]) => (!t.optional || t.optional()) && (!env?.readOnly || READ_ONLY.has(name)))
    .map(([, t]) => t.declaration);
}

/** Run a tool call from Gemini. Never throws: errors go back to Gemini so it can explain them. */
export async function runTool(name, args, env) {
  const tool = TOOLS[name];
  if (!tool) return { error: `Unknown tool: ${name}` };
  if (env?.readOnly && !READ_ONLY.has(name)) return { error: "That isn't allowed in a scheduled message." };
  try {
    return (await tool.run(args ?? {}, env)) ?? { ok: true };
  } catch (err) {
    console.error(`[tool:${name}]`, err?.message ?? err);
    return { error: String(err?.message ?? err) };
  }
}
