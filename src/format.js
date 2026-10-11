// src/format.js — turn Gemini's markdown into Telegram-safe HTML and split long replies

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Small, forgiving Markdown -> Telegram HTML converter. */
export function mdToHtml(md) {
  const stash = [];
  const keep = (html) => `\uE000${stash.push(html) - 1}\uE001`;

  // 1) protect code so nothing inside it gets formatted
  let s = md.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_, code) =>
    keep(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`),
  );
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));

  // 2) escape everything else, then add our own tags
  s = escapeHtml(s)
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/gm, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2">$1</a>');

  // 3) put the protected code back
  return s.replace(/\uE000(\d+)\uE001/g, (_, i) => stash[Number(i)]);
}

/** Split text into chunks that fit Telegram's 4096-char limit (prefers paragraph breaks). */
export function splitText(text, max = 3500) {
  const chunks = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };

  for (const para of text.split(/\n{2,}/)) {
    if (para.length > max) {
      flush();
      for (let i = 0; i < para.length; i += max) chunks.push(para.slice(i, i + max));
      continue;
    }
    if (cur && (cur + "\n\n" + para).length > max) flush();
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  flush();
  return chunks.length ? chunks : [text];
}

/** Send chunks through any "send" function; the last chunk also gets `lastExtra` (e.g. buttons). */
async function sendChunks(send, text, extra, lastExtra) {
  const chunks = splitText(text);
  for (let i = 0; i < chunks.length; i++) {
    const opts = { ...extra, ...(i === chunks.length - 1 ? lastExtra : {}) };
    try {
      await send(mdToHtml(chunks[i]), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...opts });
    } catch (err) {
      console.error("[format] HTML rejected, sending plain text:", err?.description ?? err?.message);
      await send(chunks[i], opts);
    }
  }
}

/** Reply to the current message with formatting; falls back to plain text if Telegram rejects the HTML. */
export const replyLong = (ctx, text, extra = {}, lastExtra = {}) =>
  sendChunks((t, o) => ctx.reply(t, o), text, extra, lastExtra);

/** Send to a chat id without a ctx (used by reminders and the daily briefing). */
export const sendLongTo = (api, chatId, text, extra = {}, lastExtra = {}) =>
  sendChunks((t, o) => api.sendMessage(chatId, t, o), text, extra, lastExtra);
