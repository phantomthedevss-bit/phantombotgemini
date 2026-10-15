// src/kb.js — small helpers shared by every part of the bot that draws buttons.
import { InlineKeyboard } from "grammy";

/** rows = [[label, callbackData], ...][]  ->  InlineKeyboard (empty rows are dropped). */
export const kb = (rows) =>
  InlineKeyboard.from(rows.filter((r) => r.length).map((r) => r.map(([label, data]) => InlineKeyboard.text(label, data))));

/** Split a flat list of buttons into rows of n. */
export const chunkRows = (buttons, n) => {
  const rows = [];
  for (let i = 0; i < buttons.length; i += n) rows.push(buttons.slice(i, i + n));
  return rows;
};

export const BACK = [["⬅️ Menu", "menu:main"]];
export const GAMES_BACK = [["🎮 Games", "menu:games"]];

/** A "view" is { text, kb }. Buttons edit the message in place; falls back to a new message. */
export async function show(ctx, view) {
  const opts = { reply_markup: view.kb, link_preview_options: { is_disabled: true } };
  try {
    await ctx.editMessageText(view.text, opts);
  } catch (err) {
    if (!/not modified/i.test(err?.description ?? err?.message ?? "")) await ctx.reply(view.text, opts);
  }
}

/** Random integer in [0, n). */
export const rnd = (n) => Math.floor(Math.random() * n);
export const pick = (arr) => arr[rnd(arr.length)];

/** Fisher-Yates shuffle (returns a new array). */
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
