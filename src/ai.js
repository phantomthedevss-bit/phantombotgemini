// src/ai.js — everything that talks to Google Gemini (chat, memory, personas, function calling)
import { GoogleGenAI } from "@google/genai";
import { toolDeclarations, runTool } from "./tools.js";
import { nowLocalIso } from "./timeutil.js";

const getModel = () => process.env.GEMINI_MODEL || "gemini-3.5-flash";
const getFallbackModel = () => process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
const MAX_TURNS = Number(process.env.MAX_HISTORY_TURNS || 12);
const MAX_TOOL_STEPS = 5;

let client;
function getClient() {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

/* ------------------------------ Personalities ------------------------------ */

export const BASE_PROMPT = `You are PHANTOM AI, a sharp, friendly assistant living inside Telegram.
- Reply in the same language the user writes in.
- Be direct and useful. No filler, no repeating the question.
- Formatting: you may use **bold**, *italic*, \`inline code\`, fenced code blocks and simple "-" bullet lists.
  Do NOT use markdown tables or "#" headings (Telegram can't render them).
- If you are unsure or don't know something, say so instead of guessing.`;

export const MODES = {
  assistant: { label: "General assistant", prompt: BASE_PROMPT },
  coder: {
    label: "Coding expert",
    prompt: `${BASE_PROMPT}
You are a senior software engineer. Give working, minimal code in fenced code blocks, then a short explanation.
Point out bugs, edge cases and security issues you notice.`,
  },
  teacher: {
    label: "Patient teacher",
    prompt: `${BASE_PROMPT}
You are a patient teacher. Explain step by step with simple words and small examples.
End with one short question that checks the user's understanding.`,
  },
  concise: {
    label: "Ultra concise",
    prompt: `${BASE_PROMPT}
Answer in the fewest words possible: 1-3 short sentences unless the user explicitly asks for more.`,
  },
};

/** The active persona for a profile: a built-in mode or one the user created. */
export function resolvePersona(profile) {
  const custom = profile.personas?.[profile.mode];
  if (custom) return { key: profile.mode, label: `Custom: ${profile.mode}`, prompt: `${BASE_PROMPT}\n${custom}` };
  const builtin = MODES[profile.mode] ?? MODES.assistant;
  return { key: MODES[profile.mode] ? profile.mode : "assistant", label: builtin.label, prompt: builtin.prompt };
}

function buildSystem(profile, withTools) {
  const persona = resolvePersona(profile);
  const lines = [persona.prompt, ""];

  if (profile.name) lines.push(`The user's name is ${profile.name}.`);
  if (profile.facts?.length) {
    lines.push(
      "Things you know about the user (use them naturally when relevant; don't recite them unprompted):",
      ...profile.facts.map((f) => `- ${f}`),
    );
  }
  lines.push(
    `User's time zone: ${profile.tz}${profile.tzSet ? "" : " (not set yet, UTC assumed)"}.`,
    `User's current local time: ${nowLocalIso(profile.tz)} (UTC now: ${new Date().toISOString().slice(0, 16)}).`,
  );

  if (withTools) {
    lines.push(
      "",
      "You can call tools. Rules:",
      "- Use tools for live data (weather, news, prices, exchange rates, web pages) instead of guessing.",
      "- Use the calculator tool for any non-trivial arithmetic.",
      "- If the user shares an important lasting detail about themselves or asks you to remember something, call save_fact.",
      "- For reminders call set_reminder. Use in_minutes for relative times; for clock times compute datetime_local from the user's current local time above.",
      "- For repeating reminders ('every day at 8', 'every Monday') also set repeat, with datetime_local = the first occurrence.",
      "- Tasks without a specific time go on the to-do list: add_todo, list_todos, complete_todo, delete_todo.",
      "- If the user says where they live and their time zone isn't set, call set_timezone.",
      "- Never claim you set a reminder, saved a fact or changed a setting unless the tool result confirms it. If a tool returns an error, explain it simply.",
      "- When you used a tool, answer in natural language; don't dump raw JSON.",
    );
  }
  return lines.join("\n");
}

/* ------------------------------- Gemini calls ------------------------------ */

function modelList() {
  return [getModel(), getFallbackModel()].filter((m, i, arr) => m && arr.indexOf(m) === i);
}

async function callModel(models, contents, config) {
  const ai = getClient();
  let lastError;
  for (const model of models) {
    try {
      const res = await ai.models.generateContent({ model, contents, config });
      return res;
    } catch (err) {
      lastError = err;
      console.error(`[gemini] ${model} failed:`, err?.status ?? "", err?.message ?? err);
    }
  }
  throw lastError;
}

/** Generate text, letting Gemini call tools in a loop until it has a final answer. */
async function generate({ contents, system, env }) {
  const decls = env ? toolDeclarations() : [];
  const models = modelList();
  const convo = [...contents];

  for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
    const lastStep = step === MAX_TOOL_STEPS; // force a text answer on the final round
    const config = { systemInstruction: system };
    if (decls.length && !lastStep) config.tools = [{ functionDeclarations: decls }];

    const res = await callModel(models, convo, config);
    const calls = res.functionCalls;

    if (!calls?.length) {
      const text = (res.text || "").trim();
      if (text) return text;
      throw new Error("Empty response (the answer may have been blocked by safety filters).");
    }

    // Keep Gemini's own turn untouched (it carries thought signatures), then answer every call.
    convo.push(res.candidates[0].content);
    const responses = [];
    for (const call of calls) {
      const result = await runTool(call.name, call.args, env);
      responses.push({ functionResponse: { name: call.name, response: { result } } });
    }
    convo.push({ role: "user", parts: responses });
  }
  throw new Error("Too many tool steps.");
}

const partsToText = (parts) => parts.map((p) => p.text).filter(Boolean).join("\n");
const toContents = (history) => history.map((h) => ({ role: h.role, parts: [{ text: h.text }] }));

/**
 * Chat with saved memory, personas, facts and tools.
 * @param {object} a
 * @param {object} a.store       persistence (see store.js)
 * @param {string|number} a.userId
 * @param {string|number} a.chatId
 * @param {Array} a.parts        Gemini parts for this user turn (text and/or inlineData)
 * @param {string} [a.historyNote]  What to store in memory instead of raw media
 * @param {string} [a.name]      The user's first name (saved to their profile)
 */
export async function chat({ store, userId, chatId, parts, historyNote, name }) {
  const profile = await store.getProfile(userId);
  if (name && profile.name !== name) {
    profile.name = name;
    await store.saveProfile(userId, profile);
  }

  const history = await store.getHistory(chatId);
  const contents = [...toContents(history), { role: "user", parts }];
  const env = { store, userId, chatId, profile };
  const text = await generate({ contents, system: buildSystem(profile, true), env });

  history.push({ role: "user", text: historyNote ?? partsToText(parts) }, { role: "model", text });
  await store.saveHistory(chatId, history.slice(-MAX_TURNS * 2));
  return text;
}

/** Redo the last answer. Returns null if there's nothing (text-only) to redo. */
export async function regenerate({ store, userId, chatId, name }) {
  const history = await store.getHistory(chatId);
  const last = history.at(-2);
  if (!last || last.role !== "user" || last.text.startsWith("[User sent")) return null;
  await store.saveHistory(chatId, history.slice(0, -2));
  return chat({ store, userId, chatId, parts: [{ text: last.text }], name });
}

/** One-off task with no memory and no tools (translate, summarize, fix, briefing...). */
export async function oneShot(instruction, userText) {
  return generate({
    contents: [{ role: "user", parts: [{ text: userText }] }],
    system: `${instruction}\n\nCurrent date/time (UTC): ${new Date().toUTCString()}`,
    env: null,
  });
}

/* --------------------------------- Errors ---------------------------------- */

export function friendlyError(err) {
  const msg = String(err?.message ?? err ?? "");
  const status = Number(err?.status ?? err?.code);

  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg)) {
    return "⏳ I've hit Gemini's free-tier rate limit. Give me a minute and try again.";
  }
  if (status === 400 && /API key/i.test(msg)) return "🔑 The Gemini API key looks invalid. Check GEMINI_API_KEY.";
  if (status === 401 || status === 403) return "🔑 Gemini rejected the API key (or this region/model isn't allowed).";
  if (status === 404) return "🤖 The configured Gemini model wasn't found. Check GEMINI_MODEL.";
  if (/safety|blocked|Empty response/i.test(msg)) return "🚫 Gemini didn't return an answer for that (possibly blocked by safety filters).";
  if (/GEMINI_API_KEY is not set/.test(msg)) return "⚙️ GEMINI_API_KEY is missing on the server.";
  if (/UPSTASH|Redis|fetch failed.*upstash/i.test(msg)) return "💾 I couldn't reach my database. Check the Upstash credentials.";
  return "⚠️ Something went wrong while talking to Gemini. Please try again.";
}
