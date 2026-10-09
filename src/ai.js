// src/ai.js — everything that talks to Google Gemini
import { GoogleGenAI } from "@google/genai";

const getModel = () => process.env.GEMINI_MODEL || "gemini-3.5-flash";
const getFallbackModel = () => process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
const MAX_TURNS = Number(process.env.MAX_HISTORY_TURNS || 12);
const MAX_SESSIONS = 500;

let client;
function getClient() {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

/* ------------------------------ Personalities ------------------------------ */

const BASE_PROMPT = `You are PHANTOM AI, a sharp, friendly assistant living inside Telegram.
- Reply in the same language the user writes in.
- Be direct and useful. No filler, no repeating the question.
- Formatting: you may use **bold**, *italic*, \`inline code\`, fenced code blocks and simple "-" bullet lists.
  Do NOT use markdown tables or "#" headings (Telegram can't render them).
- If you are unsure or don't know something, say so instead of guessing.`;

export const MODES = {
  assistant: {
    label: "General assistant",
    prompt: BASE_PROMPT,
  },
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

/* --------------------------------- Sessions -------------------------------- */
// NOTE: kept in memory. On Vercel (serverless) and on Render's free tier the memory is
// wiped when the instance goes to sleep / restarts. That's fine for casual chatting.
const sessions = new Map();

function session(chatId) {
  let s = sessions.get(chatId);
  if (!s) {
    s = { mode: "assistant", history: [] };
    sessions.set(chatId, s);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }
  return s;
}

export const getMode = (chatId) => session(chatId).mode;

export function setMode(chatId, mode) {
  if (!MODES[mode]) return false;
  session(chatId).mode = mode;
  return true;
}

export function resetSession(chatId) {
  session(chatId).history = [];
}

/* ------------------------------- Generation -------------------------------- */

function withDate(prompt) {
  return `${prompt}\n\nCurrent date/time (UTC): ${new Date().toUTCString()}`;
}

async function generate({ contents, system }) {
  const ai = getClient();
  const models = [getModel(), getFallbackModel()].filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastError;

  for (const model of models) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents,
        config: { systemInstruction: withDate(system) },
      });
      const text = (res.text || "").trim();
      if (text) return text;
      lastError = new Error("Empty response (the answer may have been blocked by safety filters).");
    } catch (err) {
      lastError = err;
      console.error(`[gemini] ${model} failed:`, err?.status ?? "", err?.message ?? err);
    }
  }
  throw lastError;
}

const partsToText = (parts) => parts.map((p) => p.text).filter(Boolean).join("\n");

/**
 * Chat with memory.
 * @param {string|number} chatId
 * @param {Array} parts      Gemini parts for this user turn (text and/or inlineData)
 * @param {string} [historyNote]  What to store in memory instead of raw media (keeps memory small)
 */
export async function chat(chatId, parts, historyNote) {
  const s = session(chatId);
  const contents = [...s.history, { role: "user", parts }];
  const text = await generate({ contents, system: MODES[s.mode].prompt });

  s.history.push(
    { role: "user", parts: [{ text: historyNote ?? partsToText(parts) }] },
    { role: "model", parts: [{ text }] },
  );
  s.history = s.history.slice(-MAX_TURNS * 2);
  return text;
}

/** One-off task with no memory (translate, summarize, fix...). */
export async function oneShot(instruction, userText) {
  return generate({
    contents: [{ role: "user", parts: [{ text: userText }] }],
    system: instruction,
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
  return "⚠️ Something went wrong while talking to Gemini. Please try again.";
}
