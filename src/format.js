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

/** Reply with formatting; if Telegram rejects the HTML, fall back to plain text. */
export async function replyLong(ctx, text, extra = {}) {
  for (const chunk of splitText(text)) {
    try {
      await ctx.reply(mdToHtml(chunk), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...extra,
      });
    } catch (err) {
      console.error("[format] HTML rejected, sending plain text:", err?.description ?? err?.message);
      await ctx.reply(chunk, extra);
    }
  }
}
