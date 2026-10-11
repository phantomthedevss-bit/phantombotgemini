// src/store.js — persistence. Uses Upstash Redis when configured, otherwise RAM (resets on restart).
import { Redis } from "@upstash/redis";
import { nextOccurrence } from "./timeutil.js";

/* ------------- tiny in-memory stand-in with the Redis commands we use ------------- */
class MemoryRedis {
  constructor() {
    this.kv = new Map();
    this.hashes = new Map();
    this.zsets = new Map();
    this.sets = new Map();
  }
  async get(k) { return this.kv.get(k) ?? null; }
  async set(k, v) { this.kv.set(k, String(v)); return "OK"; }
  async del(k) { return this.kv.delete(k) ? 1 : 0; }
  async hset(k, obj) {
    const h = this.hashes.get(k) ?? new Map();
    for (const [f, v] of Object.entries(obj)) h.set(f, String(v));
    this.hashes.set(k, h);
    return Object.keys(obj).length;
  }
  async hget(k, f) { return this.hashes.get(k)?.get(f) ?? null; }
  async hgetall(k) {
    const h = this.hashes.get(k);
    return h && h.size ? Object.fromEntries(h) : null;
  }
  async hdel(k, f) { return this.hashes.get(k)?.delete(f) ? 1 : 0; }
  async incr(k) {
    const n = Number(this.kv.get(k) ?? 0) + 1;
    this.kv.set(k, String(n));
    return n;
  }
  async expire() { return 1; }
  async zadd(k, { score, member }) {
    const z = this.zsets.get(k) ?? new Map();
    z.set(member, score);
    this.zsets.set(k, z);
    return 1;
  }
  async zrange(k, min, max) {
    const z = this.zsets.get(k) ?? new Map();
    return [...z.entries()].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1]).map(([m]) => m);
  }
  async zrem(k, member) { return this.zsets.get(k)?.delete(member) ? 1 : 0; }
}

// One shared connection per server instance.
let shared;
function connect() {
  if (shared) return shared;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) {
    shared = { redis: new Redis({ url, token, automaticDeserialization: false }), persistent: true };
  } else {
    console.warn("[store] No Upstash credentials found: using RAM only (reminders & briefings disabled).");
    shared = { redis: new MemoryRedis(), persistent: false };
  }
  return shared;
}

const json = (v) => JSON.stringify(v);
const parse = (s, fallback = null) => {
  if (s === null || s === undefined) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

// The real Upstash client returns HGETALL as a flat [field, value, field, value...] array
// when automatic deserialization is off; the memory stand-in returns an object. Handle both.
function pairsToObject(r) {
  if (!r) return {};
  if (!Array.isArray(r)) return r;
  const out = {};
  for (let i = 0; i < r.length; i += 2) out[r[i]] = r[i + 1];
  return out;
}

const MAX_FACTS = 60;
const defaultProfile = () => ({
  tz: "UTC",
  mode: "assistant",
  facts: [],
  personas: {},
  todos: [], // [{ t: "buy milk", done: false }]
  briefing: { on: false, h: 7, mi: 30, city: "", topics: [] },
});

const MAX_TODOS = 50;

/** One store per bot. Keys are namespaced with the bot id so two bots never mix data. */
export function createStore(botId) {
  const { redis, persistent } = connect();
  const k = (...parts) => `phantom:${botId}:${parts.join(":")}`;
  const DUE = k("due"); // sorted set: member = "r|userId|reminderId" or "b|userId", score = UTC ms

  return {
    persistent,

    /* ----------------------------- profile ----------------------------- */
    async getProfile(userId) {
      const saved = parse(await redis.get(k("user", userId)), {});
      const base = defaultProfile();
      return { ...base, ...saved, briefing: { ...base.briefing, ...(saved.briefing ?? {}) } };
    },
    async saveProfile(userId, profile) {
      await redis.set(k("user", userId), json(profile));
    },

    async addFact(userId, fact) {
      const p = await this.getProfile(userId);
      const clean = String(fact).trim().slice(0, 300);
      if (!clean) return p.facts;
      if (!p.facts.some((f) => f.toLowerCase() === clean.toLowerCase())) p.facts.push(clean);
      p.facts = p.facts.slice(-MAX_FACTS);
      await this.saveProfile(userId, p);
      return p.facts;
    },
    async removeFact(userId, index) {
      const p = await this.getProfile(userId);
      const [removed] = p.facts.splice(index, 1);
      await this.saveProfile(userId, p);
      return removed;
    },

    /* ------------------------------- to-do list ------------------------------ */
    async addTodo(userId, text) {
      const p = await this.getProfile(userId);
      const clean = String(text).trim().slice(0, 200);
      if (!clean) return p.todos;
      if (p.todos.length >= MAX_TODOS) throw new Error(`The to-do list is full (${MAX_TODOS} items). Clear some first.`);
      p.todos.push({ t: clean, done: false });
      await this.saveProfile(userId, p);
      return p.todos;
    },
    /** done = true/false to set, or undefined to toggle. Returns the item, or null if the index is wrong. */
    async setTodoDone(userId, index, done) {
      const p = await this.getProfile(userId);
      const item = p.todos[index];
      if (!item) return null;
      item.done = done === undefined ? !item.done : done;
      await this.saveProfile(userId, p);
      return item;
    },
    async removeTodo(userId, index) {
      const p = await this.getProfile(userId);
      const [removed] = p.todos.splice(index, 1);
      await this.saveProfile(userId, p);
      return removed ?? null;
    },
    async clearDoneTodos(userId) {
      const p = await this.getProfile(userId);
      const before = p.todos.length;
      p.todos = p.todos.filter((x) => !x.done);
      await this.saveProfile(userId, p);
      return before - p.todos.length;
    },

    /* ------------------------------ daily usage ------------------------------ */
    // Only used when DAILY_MESSAGE_LIMIT is set, so it costs nothing otherwise.
    async bumpUsage(userId) {
      const key = k("usage", userId, new Date().toISOString().slice(0, 10));
      const n = Number(await redis.incr(key));
      if (n === 1) await redis.expire(key, 172_800);
      return n;
    },
    async getUsage(userId) {
      return Number((await redis.get(k("usage", userId, new Date().toISOString().slice(0, 10)))) ?? 0);
    },

    /* ----------------------------- history ----------------------------- */
    async getHistory(chatId) {
      return parse(await redis.get(k("hist", chatId)), []);
    },
    async saveHistory(chatId, history) {
      await redis.set(k("hist", chatId), json(history));
    },
    async clearHistory(chatId) {
      await redis.del(k("hist", chatId));
    },

    /* ---------------------------- reminders ---------------------------- */
    async addReminder({ userId, chatId, text, dueAt, repeat }) {
      const id = Math.random().toString(36).slice(2, 8);
      await redis.hset(k("rem", userId), { [id]: json({ id, chatId, text, dueAt, repeat: repeat || undefined }) });
      await redis.zadd(DUE, { score: dueAt, member: `r|${userId}|${id}` });
      return id;
    },
    /** Move a (repeating) reminder to its next time. */
    async rescheduleReminder(userId, reminder, dueAt) {
      await redis.hset(k("rem", userId), { [reminder.id]: json({ ...reminder, dueAt }) });
      await redis.zadd(DUE, { score: dueAt, member: `r|${userId}|${reminder.id}` });
    },
    async listReminders(userId) {
      const all = pairsToObject(await redis.hgetall(k("rem", userId)));
      return Object.values(all).map((v) => parse(v)).filter(Boolean).sort((a, b) => a.dueAt - b.dueAt);
    },
    async cancelReminder(userId, id) {
      const existed = await redis.hdel(k("rem", userId), id);
      await redis.zrem(DUE, `r|${userId}|${id}`);
      return existed > 0;
    },
    async getReminder(userId, id) {
      return parse(await redis.hget(k("rem", userId), id));
    },
    async deleteReminderData(userId, id) {
      await redis.hdel(k("rem", userId), id);
    },

    /* ------------------------ time zone & briefing ---------------------- */
    async scheduleBriefing(userId, atMs) {
      await redis.zadd(DUE, { score: atMs, member: `b|${userId}` });
    },
    async unscheduleBriefing(userId) {
      await redis.zrem(DUE, `b|${userId}`);
    },

    /** Change briefing settings and (re)schedule the next send. Returns the updated profile. */
    async configureBriefing(userId, patch) {
      const p = await this.getProfile(userId);
      p.briefing = { ...p.briefing, ...patch };
      await this.saveProfile(userId, p);
      if (persistent) {
        if (p.briefing.on) await this.scheduleBriefing(userId, nextOccurrence(p.briefing.h, p.briefing.mi, p.tz));
        else await this.unscheduleBriefing(userId);
      }
      return p;
    },

    async setTimezone(userId, tz) {
      const p = await this.getProfile(userId);
      p.tz = tz;
      p.tzSet = true;
      await this.saveProfile(userId, p);
      if (persistent && p.briefing.on) {
        await this.scheduleBriefing(userId, nextOccurrence(p.briefing.h, p.briefing.mi, tz));
      }
      return p;
    },

    /* --------------------------- due scheduler -------------------------- */
    /** Returns the due items that THIS call successfully claimed (safe if two crons overlap). */
    async claimDue(now = Date.now()) {
      const members = await redis.zrange(DUE, 0, now, { byScore: true });
      const claimed = [];
      for (const member of members) {
        if ((await redis.zrem(DUE, member)) === 1) claimed.push(member);
      }
      return claimed;
    },
  };
}
