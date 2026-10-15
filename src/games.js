// src/games.js — offline games: no API, no keys, no Gemini quota (all data lives in src/data.js).
// Game state for a chat is one small JSON doc, kept for 2 hours, so a game survives a server
// restart but never lingers forever. Multiplayer games (trivia, word chain) are per-chat; the
// rest are per-user so two people in the same group don't collide.
import {
  TRIVIA, TRIVIA_CATEGORIES, HANGMAN, RIDDLES, EMOJI_PUZZLES, WYR, TRUTHS, DARES, JOKES, QUOTES, FACTS, EIGHT_BALL,
} from "./data.js";
import { kb, chunkRows, BACK, GAMES_BACK, rnd, pick, shuffle } from "./kb.js";

const GAME_TTL = 2 * 3600; // seconds

const loadGame = (store, chatId) => store.getDoc("game", chatId);
const saveGame = (store, chatId, state) => store.setDoc("game", chatId, state, GAME_TTL);
const clearGame = (store, chatId) => store.delDoc("game", chatId);

/* ---------------------------------- games menu --------------------------------- */

export function viewGames() {
  return {
    text: "🎮 *Games*\n\nPick one — all of these work instantly, no internet data used beyond Telegram itself.",
    kb: kb([
      [["🧠 Trivia", "g:triv:menu"], ["🔤 Hangman", "g:hang:menu"]],
      [["🧩 Riddles", "g:ridl:go"], ["😀 Emoji Quiz", "g:emoj:go"]],
      [["🤔 Would You Rather", "g:wyr:go"], ["🎯 Truth or Dare", "g:td:menu"]],
      [["🔢 Guess the Number", "g:num:start"], ["⭕ Tic-Tac-Toe", "g:ttt:start"]],
      [["✊ Rock Paper Scissors", "g:rps:menu"], ["🎲 Dice / Coin", "g:rand:menu"]],
      [["🎱 Magic 8-Ball", "g:ball:go"], ["😂 Joke", "g:joke:go"]],
      [["💬 Quote", "g:quote:go"], ["🤓 Random Fact", "g:fact:go"]],
      [["🔗 Word Chain", "g:chain:start"], ["🏆 Scoreboard", "g:score:show"]],
      BACK,
    ]),
  };
}

const parseMode = { parse_mode: "Markdown" };

/* ------------------------------------ scores ------------------------------------ */

async function bump(store, userId, game, delta = 1) {
  const p = await store.getProfile(userId);
  p.scores[game] = (p.scores[game] ?? 0) + delta;
  await store.saveProfile(userId, p);
  return p.scores[game];
}

export async function viewScoreboard(store, userId) {
  const p = await store.getProfile(userId);
  const entries = Object.entries(p.scores ?? {}).sort((a, b) => b[1] - a[1]);
  const LABELS = {
    trivia: "🧠 Trivia correct", hangman: "🔤 Hangman wins", riddles: "🧩 Riddles solved", emoji: "😀 Emoji quiz solved",
    ttt: "⭕ Tic-Tac-Toe wins", rps: "✊ RPS wins", number: "🔢 Number games won", chain: "🔗 Word chain rounds",
  };
  const text = entries.length
    ? `🏆 *Your scoreboard*\n\n${entries.map(([k, v]) => `${LABELS[k] ?? k}: *${v}*`).join("\n")}`
    : "🏆 *Your scoreboard*\n\nNo scores yet — play something!";
  return { text, kb: kb([GAMES_BACK]) };
}

/* ------------------------------------ trivia ------------------------------------ */

export function viewTriviaMenu() {
  const rows = chunkRows(Object.entries(TRIVIA_CATEGORIES).map(([key, c]) => [c.label, `g:triv:cat:${key}`]), 2);
  return { text: "🧠 *Trivia* — pick a category:", kb: kb([...rows, GAMES_BACK]) };
}

export async function startTrivia(store, chatId, userId, category) {
  const bank = TRIVIA[category];
  if (!bank) return viewTriviaMenu();
  const [q, correct, ...wrong] = pick(bank);
  const options = shuffle([correct, ...wrong]);
  await saveGame(store, chatId, { kind: "trivia", category, q, correct, options, userId, streak: 0 });
  return viewTriviaQuestion(q, options, category);
}

function viewTriviaQuestion(q, options, category) {
  const letters = ["🅰️", "🅱️", "🅲️", "🅳️"];
  const text = `${TRIVIA_CATEGORIES[category]?.label ?? "🧠 Trivia"}\n\n*${q}*`;
  const rows = options.map((opt, i) => [`${letters[i]} ${opt}`, `g:triv:a:${i}`]);
  return { text, kb: kb([...chunkRows(rows, 1), [["⏭ Skip", `g:triv:cat:${category}`]], GAMES_BACK]) };
}

export async function answerTrivia(store, chatId, userId, index) {
  const g = await loadGame(store, chatId);
  if (!g || g.kind !== "trivia") return { text: "No trivia question is active. Start one from the Games menu.", kb: kb([GAMES_BACK]) };
  const picked = g.options[index];
  const right = picked === g.correct;
  let streak = g.streak;
  if (right) {
    streak += 1;
    await bump(store, userId, "trivia", 1);
  } else {
    streak = 0;
  }
  const [q, correct, ...wrong] = pick(TRIVIA[g.category]);
  const options = shuffle([correct, ...wrong]);
  await saveGame(store, chatId, { kind: "trivia", category: g.category, q, correct, options, userId, streak });
  const head = right ? `✅ Correct! (${picked})` : `❌ Not quite — it was *${g.correct}*.`;
  const streakLine = streak > 1 ? `\n🔥 Streak: ${streak}` : "";
  const next = viewTriviaQuestion(q, options, g.category);
  return { text: `${head}${streakLine}\n\n${next.text}`, kb: next.kb };
}

/* ----------------------------------- hangman ----------------------------------- */

export function viewHangmanMenu() {
  const rows = Object.entries(HANGMAN).map(([key, c]) => [c.label, `g:hang:cat:${key}`]);
  return { text: "🔤 *Hangman* — pick a category:", kb: kb([...chunkRows(rows, 2), GAMES_BACK]) };
}

const HANGMAN_STAGES = ["🫥", "😬", "😟", "😨", "😰", "😵", "💀"];

function renderWord(word, guessed) {
  return word.split("").map((c) => (guessed.includes(c) ? c : "_")).join(" ");
}

function viewHangman(g) {
  const wrong = g.wrong.length;
  const stage = HANGMAN_STAGES[Math.min(wrong, HANGMAN_STAGES.length - 1)];
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const rows = chunkRows(
    letters.map((l) => [g.guessed.includes(l) ? (g.word.includes(l) ? "🟢" + l : "⚪" + l) : l.toUpperCase(), g.guessed.includes(l) ? "g:noop" : `g:hang:g:${l}`]),
    7,
  );
  const text =
    `${stage} *Hangman* (${HANGMAN[g.category].label})\n\n` +
    `\`${renderWord(g.word, g.guessed)}\`\n\n` +
    `Wrong guesses: ${wrong}/6${g.wrong.length ? ` (${g.wrong.join(", ").toUpperCase()})` : ""}`;
  return { text, kb: kb([...rows, [["🔁 New word", `g:hang:cat:${g.category}`]], GAMES_BACK]) };
}

export async function startHangman(store, chatId, userId, category) {
  const cat = HANGMAN[category];
  if (!cat) return viewHangmanMenu();
  const word = pick(cat.words);
  const g = { kind: "hangman", category, word, guessed: [], wrong: [], userId };
  await saveGame(store, chatId, g);
  return viewHangman(g);
}

export async function guessHangman(store, chatId, userId, letter) {
  const g = await loadGame(store, chatId);
  if (!g || g.kind !== "hangman") return { text: "No hangman game is active. Start one from the Games menu.", kb: kb([GAMES_BACK]) };
  if (!g.guessed.includes(letter)) {
    g.guessed.push(letter);
    if (!g.word.includes(letter)) g.wrong.push(letter);
  }
  const solved = g.word.split("").every((c) => g.guessed.includes(c));
  const dead = g.wrong.length >= 6;
  if (solved || dead) {
    if (solved) await bump(store, userId, "hangman", 1);
    await clearGame(store, chatId);
    const text = solved
      ? `🎉 You got it — *${g.word.toUpperCase()}*!`
      : `💀 Out of guesses. The word was *${g.word.toUpperCase()}*.`;
    return { text, kb: kb([[["🔁 Play again", `g:hang:cat:${g.category}`]], GAMES_BACK]) };
  }
  await saveGame(store, chatId, g);
  return viewHangman(g);
}

/* ----------------------------------- riddles / emoji / wyr ----------------------------------- */

export async function viewRiddle(store, chatId, userId) {
  const [q, a] = pick(RIDDLES);
  await saveGame(store, chatId, { kind: "riddle", answer: a, userId });
  return { text: `🧩 *Riddle*\n\n${q}\n\n_Tap Reveal when you've got a guess._`, kb: kb([[["👀 Reveal", "g:ridl:reveal"], ["⏭ Another", "g:ridl:go"]], GAMES_BACK]) };
}
export async function revealRiddle(store, chatId, userId) {
  const g = await loadGame(store, chatId);
  if (g?.kind === "riddle") await bump(store, userId, "riddles", 1);
  const text = g?.kind === "riddle" ? `💡 Answer: *${g.answer}*` : "No riddle is active.";
  return { text, kb: kb([[["⏭ Another", "g:ridl:go"]], GAMES_BACK]) };
}

export function viewEmoji() {
  const [clue, answer] = pick(EMOJI_PUZZLES);
  return { text: `😀 *Emoji Quiz*\n\n${clue}\n\n_What movie/show/phrase is this?_`, kb: kb([[["👀 Reveal", `g:emoj:rev:${encodeURIComponent(answer)}`], ["⏭ Another", "g:emoj:go"]], GAMES_BACK]) };
}
export function revealEmoji(answer) {
  return { text: `💡 Answer: *${decodeURIComponent(answer)}*`, kb: kb([[["⏭ Another", "g:emoj:go"]], GAMES_BACK]) };
}

export function viewWyr() {
  const [a, b] = pick(WYR);
  return { text: `🤔 *Would you rather...*\n\n🅰️ ${a}\n\n— or —\n\n🅱️ ${b}`, kb: kb([[["🅰️", "g:wyr:go"], ["🅱️", "g:wyr:go"]], GAMES_BACK]) };
}

export function viewTruthOrDare() {
  return { text: "🎯 *Truth or Dare*", kb: kb([[["💭 Truth", "g:td:truth"], ["🔥 Dare", "g:td:dare"]], GAMES_BACK]) };
}
export function viewTruth() {
  return { text: `💭 *Truth*\n\n${pick(TRUTHS)}`, kb: kb([[["💭 Another truth", "g:td:truth"], ["🔥 Dare instead", "g:td:dare"]], GAMES_BACK]) };
}
export function viewDare() {
  return { text: `🔥 *Dare*\n\n${pick(DARES)}`, kb: kb([[["🔥 Another dare", "g:td:dare"], ["💭 Truth instead", "g:td:truth"]], GAMES_BACK]) };
}

export function viewJoke() {
  return { text: `😂 ${pick(JOKES)}`, kb: kb([[["😂 Another", "g:joke:go"]], GAMES_BACK]) };
}
export function viewQuote() {
  const [text, author] = pick(QUOTES);
  return { text: `💬 _"${text}"_\n— ${author}`, kb: kb([[["💬 Another", "g:quote:go"]], GAMES_BACK]) };
}
export function viewFact() {
  return { text: `🤓 ${pick(FACTS)}`, kb: kb([[["🤓 Another", "g:fact:go"]], GAMES_BACK]) };
}
export function viewEightBall(question) {
  const text = question ? `🎱 *${question}*\n\n${pick(EIGHT_BALL)}` : `🎱 ${pick(EIGHT_BALL)}`;
  return { text, kb: kb([[["🎱 Ask again", "g:ball:go"]], GAMES_BACK]) };
}

/* -------------------------------- guess the number -------------------------------- */

export async function startNumberGame(store, chatId, userId) {
  const target = 1 + rnd(50);
  await saveGame(store, chatId, { kind: "number", target, tries: 0, userId });
  return {
    text: "🔢 *Guess the Number*\n\nI'm thinking of a number between *1 and 50*. Type your guess as a message, or tap a shortcut below.",
    kb: kb([[["25", "g:num:g:25"], ["10", "g:num:g:10"], ["40", "g:num:g:40"]], [["🏳️ Give up", "g:num:giveup"]], GAMES_BACK]),
  };
}
export async function guessNumber(store, chatId, userId, n) {
  const g = await loadGame(store, chatId);
  if (!g || g.kind !== "number") return null; // not playing — let the caller fall through to normal chat/AI
  g.tries += 1;
  if (n === g.target) {
    await bump(store, userId, "number", 1);
    await clearGame(store, chatId);
    return { text: `🎉 *${n}* is correct! You got it in ${g.tries} ${g.tries === 1 ? "try" : "tries"}.`, kb: kb([[["🔁 Play again", "g:num:start"]], GAMES_BACK]) };
  }
  await saveGame(store, chatId, g);
  const hint = n < g.target ? "📈 Higher!" : "📉 Lower!";
  return { text: `${hint} (that was guess #${g.tries})`, kb: kb([[["🏳️ Give up", "g:num:giveup"]], GAMES_BACK]) };
}
export async function giveUpNumber(store, chatId) {
  const g = await loadGame(store, chatId);
  await clearGame(store, chatId);
  return { text: g?.kind === "number" ? `🏳️ It was *${g.target}*. Nice try!` : "No game was active.", kb: kb([[["🔁 Play again", "g:num:start"]], GAMES_BACK]) };
}

/* ------------------------------------ rock paper scissors ------------------------------------ */

const RPS = { rock: "🪨 Rock", paper: "📄 Paper", scissors: "✂️ Scissors" };
const BEATS = { rock: "scissors", paper: "rock", scissors: "paper" };

export function viewRpsMenu() {
  return { text: "✊ *Rock Paper Scissors* — your move:", kb: kb([[["🪨 Rock", "g:rps:p:rock"], ["📄 Paper", "g:rps:p:paper"], ["✂️ Scissors", "g:rps:p:scissors"]], GAMES_BACK]) };
}
export async function playRps(store, userId, choice) {
  const bot = pick(Object.keys(RPS));
  let outcome;
  if (bot === choice) outcome = "draw";
  else if (BEATS[choice] === bot) outcome = "win";
  else outcome = "lose";
  if (outcome === "win") await bump(store, userId, "rps", 1);
  const line = outcome === "win" ? "🎉 You win!" : outcome === "lose" ? "😅 I win!" : "🤝 Draw!";
  return { text: `✊ *RPS*\n\nYou: ${RPS[choice]}\nMe: ${RPS[bot]}\n\n${line}`, kb: kb([[["🔁 Play again", "g:rps:menu"]], GAMES_BACK]) };
}

/* ------------------------------------ dice / coin ------------------------------------ */

export function viewRandomMenu() {
  return {
    text: "🎲 *Random* — pick one:",
    kb: kb([[["🪙 Coin flip", "g:rand:coin"], ["🎲 Dice (1-6)", "g:rand:dice"]], [["🔢 Random number", "g:rand:num"], ["🎴 Pick a card", "g:rand:card"]], GAMES_BACK]),
  };
}
export function flipCoin() {
  return { text: `🪙 ${pick(["Heads!", "Tails!"])}`, kb: kb([[["🪙 Flip again", "g:rand:coin"]], GAMES_BACK]) };
}
export function rollDice() {
  const n = 1 + rnd(6);
  const faces = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
  return { text: `🎲 ${faces[n - 1]} You rolled a *${n}*!`, kb: kb([[["🎲 Roll again", "g:rand:dice"]], GAMES_BACK]) };
}
export function randomNumber() {
  const n = 1 + rnd(100);
  return { text: `🔢 Your random number (1-100): *${n}*`, kb: kb([[["🔢 Again", "g:rand:num"]], GAMES_BACK]) };
}
export function pickCard() {
  const suits = ["♠️", "♥️", "♦️", "♣️"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  return { text: `🎴 You drew: *${pick(ranks)}${pick(suits)}*`, kb: kb([[["🎴 Draw again", "g:rand:card"]], GAMES_BACK]) };
}

/* ------------------------------------ tic-tac-toe (vs bot) ------------------------------------ */

const TTT_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function tttWinner(b) {
  for (const [a, c, d] of TTT_LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.every(Boolean) ? "draw" : null;
}
function tttBotMove(b) {
  // Win if possible, block if needed, else center/corner/random.
  for (const player of ["O", "X"]) {
    for (const [a, c, d] of TTT_LINES) {
      const line = [a, c, d];
      const vals = line.map((i) => b[i]);
      const empty = line.filter((i) => !b[i]);
      if (empty.length === 1 && vals.filter((v) => v === player).length === 2) return empty[0];
    }
  }
  if (!b[4]) return 4;
  const corners = [0, 2, 6, 8].filter((i) => !b[i]);
  if (corners.length) return pick(corners);
  const open = b.map((v, i) => (v ? null : i)).filter((i) => i !== null);
  return pick(open);
}
function viewTtt(g) {
  const cell = (v, i) => [v || "⬜", v ? "g:noop" : `g:ttt:m:${i}`];
  const rows = [cell(g.board[0], 0), cell(g.board[1], 1), cell(g.board[2], 2)].concat();
  const grid = [
    [cell(g.board[0], 0), cell(g.board[1], 1), cell(g.board[2], 2)],
    [cell(g.board[3], 3), cell(g.board[4], 4), cell(g.board[5], 5)],
    [cell(g.board[6], 6), cell(g.board[7], 7), cell(g.board[8], 8)],
  ].map((row) => row.map(([label, data]) => [label.replace("X", "❌").replace("O", "⭕"), data]));
  return { text: "⭕ *Tic-Tac-Toe* — you're ❌, I'm ⭕.", kb: kb([...grid, [["🔁 Restart", "g:ttt:start"]], GAMES_BACK]) };
}
export async function startTtt(store, chatId, userId) {
  const g = { kind: "ttt", board: Array(9).fill(""), userId };
  await saveGame(store, chatId, g);
  return viewTtt(g);
}
export async function moveTtt(store, chatId, userId, i) {
  const g = await loadGame(store, chatId);
  if (!g || g.kind !== "ttt" || g.board[i]) return viewTtt(g ?? { board: Array(9).fill("") });
  g.board[i] = "X";
  let w = tttWinner(g.board);
  if (!w) {
    const bi = tttBotMove(g.board);
    if (bi !== undefined) g.board[bi] = "O";
    w = tttWinner(g.board);
  }
  if (w) {
    await clearGame(store, chatId);
    if (w === "X") await bump(store, userId, "ttt", 1);
    const line = w === "draw" ? "🤝 It's a draw!" : w === "X" ? "🎉 You win!" : "😅 I win!";
    const view = viewTtt(g);
    return { text: `${view.text}\n\n${line}`, kb: kb([[["🔁 Play again", "g:ttt:start"]], GAMES_BACK]) };
  }
  await saveGame(store, chatId, g);
  return viewTtt(g);
}

/* ------------------------------------ word chain (multiplayer, per chat) ------------------------------------ */

const STARTERS = ["python", "elephant", "nigeria", "telegram", "orange", "guitar", "mountain", "dolphin"];

export async function startWordChain(store, chatId) {
  const word = pick(STARTERS);
  const g = { kind: "chain", used: [word], lastLetter: word.at(-1) };
  await saveGame(store, chatId, g);
  return {
    text: `🔗 *Word Chain*\n\nI'll start: *${word}*\n\nNow reply with a real word starting with *${word.at(-1).toUpperCase()}* that hasn't been used. Anyone in the chat can play — just type it as a normal message.`,
    kb: kb([[["🏳️ End game", "g:chain:end"]], GAMES_BACK]),
  };
}
export async function endWordChain(store, chatId) {
  const g = await loadGame(store, chatId);
  await clearGame(store, chatId);
  return { text: g?.kind === "chain" ? `🏁 Word chain ended. ${g.used.length} words played: ${g.used.join(" → ")}` : "No word-chain game is active.", kb: kb([GAMES_BACK]) };
}
/**
 * Try to continue the chain with a plain-text message. Returns null when there's no active
 * game (so the caller treats the message as normal chat), or a view to show otherwise.
 */
export async function tryWordChain(store, chatId, userId, text) {
  const g = await loadGame(store, chatId);
  if (!g || g.kind !== "chain") return null;
  const word = String(text).trim().toLowerCase();
  if (!/^[a-z]{2,20}$/.test(word)) return null; // not word-shaped — ignore, let normal chat handle it
  if (word[0] !== g.lastLetter) return { text: `❌ "${word}" needs to start with *${g.lastLetter.toUpperCase()}*. Try again, or /games to quit.`, kb: kb([[["🏳️ End game", "g:chain:end"]], GAMES_BACK]) };
  if (g.used.includes(word)) return { text: `❌ "${word}" was already used. Try another word starting with *${g.lastLetter.toUpperCase()}*.`, kb: kb([[["🏳️ End game", "g:chain:end"]], GAMES_BACK]) };
  g.used.push(word);
  g.lastLetter = word.at(-1);
  await saveGame(store, chatId, g);
  await bump(store, userId, "chain", 1);
  return {
    text: `✅ *${word}* — nice. Next word starts with *${g.lastLetter.toUpperCase()}* (${g.used.length} words so far).`,
    kb: kb([[["🏳️ End game", "g:chain:end"]], GAMES_BACK]),
  };
}

export { clearGame, loadGame };
