// src/tools.js — everything Gemini is allowed to DO (function calling).
// Each tool = a declaration (what Gemini sees) + a run() function (what we execute).
// All the data tools use free APIs that need no key.
import { Type } from "@google/genai";
import { parseLocalDateTime, formatLocal, isValidTimeZone, REPEAT_LABELS } from "./timeutil.js";

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

async function readUrl(rawUrl) {
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

function calculate(expression) {
  const e = String(expression)
    .replace(/\s+/g, "")
    .replace(/[×x]/g, "*")
    .replace(/÷/g, "/")
    .replace(/\^/g, "**")
    .replace(/,/g, "");
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

/* ---------------------------------- helpers --------------------------------- */

const needDb = (env) =>
  env.store.persistent
    ? null
    : "The bot has no database connected yet, so this isn't available. Tell the user to connect Upstash Redis (see the README).";

const str = (description) => ({ type: Type.STRING, description });
const obj = (properties, required = []) => ({ type: Type.OBJECT, properties, required });

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
            enum: ["daily", "weekly", "weekdays"],
            description:
              "Only for repeating reminders. 'daily' = every day, 'weekdays' = Monday to Friday, 'weekly' = same weekday every week. " +
              "datetime_local must then be the FIRST occurrence (e.g. for 'every Monday 8am', the next Monday 08:00).",
          },
        },
        ["text"],
      ),
    },
    run: async ({ text, in_minutes, datetime_local, repeat }, env) => {
      const blocked = needDb(env);
      if (blocked) return { error: blocked };
      const tz = env.profile.tz;
      let dueAt;
      if (typeof in_minutes === "number" && in_minutes > 0) dueAt = Date.now() + Math.round(in_minutes * 60_000);
      else dueAt = parseLocalDateTime(datetime_local, tz);
      if (!dueAt) return { error: "I need either in_minutes or datetime_local (YYYY-MM-DDTHH:MM)." };
      if (dueAt < Date.now() - 30_000) return { error: "That time is already in the past. Ask the user for a future time." };
      if (dueAt > Date.now() + 366 * 86_400_000) return { error: "Reminders can be at most one year ahead." };

      const rep = ["daily", "weekly", "weekdays"].includes(repeat) ? repeat : undefined;
      const id = await env.store.addReminder({ userId: env.userId, chatId: env.chatId, text: String(text).slice(0, 500), dueAt, repeat: rep });
      return {
        ok: true,
        id,
        repeats: rep ? REPEAT_LABELS[rep] : "no (one time)",
        will_fire_at: formatLocal(dueAt, tz),
        timezone: tz,
        note: env.profile.tzSet ? undefined : "The user hasn't set a time zone yet, so UTC was assumed. Tell them to send /timezone Continent/City.",
      };
    },
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
export function toolDeclarations() {
  return Object.values(TOOLS)
    .filter((t) => !t.optional || t.optional())
    .map((t) => t.declaration);
}

/** Run a tool call from Gemini. Never throws: errors go back to Gemini so it can explain them. */
export async function runTool(name, args, env) {
  const tool = TOOLS[name];
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    return (await tool.run(args ?? {}, env)) ?? { ok: true };
  } catch (err) {
    console.error(`[tool:${name}]`, err?.message ?? err);
    return { error: String(err?.message ?? err) };
  }
}
