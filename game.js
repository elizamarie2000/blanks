// Blanks: two players take turns choosing a word while the other fills it in, one letter at a time.
// The computers talk directly over PeerJS. The chooser's computer keeps the word and answers
// each guess, so it stays hidden until the round ends.
const PREFIX = "blanks-v1-";
const TRIES = 6;
const FAIL_POINTS = 3;
const ROOM_WORDS = ["QUILL", "INK", "PAGE", "NOTE", "RIBBON", "STAMP", "INDEX", "SERIF", "LETTER", "MARGIN"];
const SURPRISES = ("LANTERN BLANKET SUNSHINE TEAPOT BICYCLE ORCHARD HARBOUR MEADOW WHISPER PUZZLE VELVET THUNDER PENGUIN "
  + "MARMALADE LIBRARY UMBRELLA NOTEBOOK KEYBOARD CUSHION BISCUIT PANCAKE RAINBOW SEASHELL HEDGEHOG ELEPHANT "
  + "TELESCOPE CROCODILE PINEAPPLE SWEATER HOLIDAY JOURNEY CURTAIN WINDMILL ISLAND MOUNTAIN STRAWBERRY").split(" ");
const $ = id => document.getElementById(id);
const cleanWord = v => String(v).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 14);
const isLetter = v => typeof v === "string" && /^[A-Z]$/.test(v);
const isWord = v => typeof v === "string" && /^[A-Z]{3,14}$/.test(v);

const S = {
  me: "", foe: "Your friend", host: false, code: "", met: false, round: 0, iChoose: false, live: false,
  word: "", len: 0, hint: "", shown: [], tried: [], left: TRIES, moves: [], pending: null,
  mine: 0, theirs: 0, iNext: false, foeNext: false, over: false,
};
let peer = null, conn = null, retry = null, leaving = false, typing = null;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- connection ----------
function bind(c) {
  conn = c;
  c.on("open", () => {
    clearTimeout(retry);
    send({ t: "hello", name: S.me });
    if (S.iChoose && S.live) send({ t: "word", len: S.word.length, hint: S.hint });
    if (S.pending) send({ t: "try", ...S.pending });
    showConn();
  });
  c.on("data", onMessage);
  c.on("close", dropped);
  c.on("error", dropped);
}

function dropped() {
  if (leaving) return;
  conn = null;
  showConn();
  if (S.live) setStatus("Your friend has dropped out. Hold on, trying to reconnect…", "lost");
  if (!S.host) { clearTimeout(retry); retry = setTimeout(connectToHost, 3000); }
}

function connectToHost() {
  if (leaving || (conn && conn.open) || !peer || peer.destroyed) return;
  bind(peer.connect(PREFIX + S.code, { reliable: true, serialization: "json" }));
  clearTimeout(retry);
  retry = setTimeout(() => { if (!conn || !conn.open) connectToHost(); }, 6000);
}

const send = m => { if (conn && conn.open) conn.send(m); };

function hostRoom() {
  S.host = true;
  S.code = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)] + "-" + (10 + Math.floor(Math.random() * 90));
  peer = new Peer(PREFIX + S.code);
  peer.on("open", () => {
    $("codeOut").textContent = S.code;
    show("wait");
  });
  peer.on("connection", c => {
    if (conn && conn.open) { c.on("open", () => { c.send({ t: "full" }); setTimeout(() => c.close(), 300); }); return; }
    bind(c);
  });
  peer.on("disconnected", () => { if (!leaving && !peer.destroyed) peer.reconnect(); });
  peer.on("error", e => {
    if (e.type === "unavailable-id") { peer.destroy(); hostRoom(); }
    else if (e.type !== "peer-unavailable" && !S.met) homeError("Couldn't connect. Check your internet and try again.");
  });
}

function joinRoom(code) {
  S.host = false;
  S.code = code;
  $("waitTitle").textContent = "Joining…";
  $("codeOut").textContent = code;
  $("waitNote").textContent = "Looking for your friend's room…";
  $("copyBtn").hidden = true;
  show("wait");
  peer = new Peer();
  peer.on("open", connectToHost);
  peer.on("disconnected", () => { if (!leaving && !peer.destroyed) peer.reconnect(); });
  peer.on("error", e => {
    if (e.type === "peer-unavailable") {
      if (S.met) return;
      clearTimeout(retry);
      homeError("No room with that code. Check it with your friend.");
    } else if (!S.met) homeError("Couldn't connect. Check your internet and try again.");
  });
}

function leave() {
  leaving = true;
  clearTimeout(retry);
  if (peer) peer.destroy();
  location.href = location.pathname;
}

function homeError(text) {
  clearTimeout(retry);
  if (peer) { leaving = true; peer.destroy(); leaving = false; peer = null; }
  conn = null;
  $("homeErr").textContent = text;
  show("home");
}

// ---------- messages from the other player ----------
function onMessage(m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "hello") {
    S.foe = String(m.name || "").trim().slice(0, 16) || "Your friend";
    if (S.host && !S.met) {
      S.met = true;
      const iChoose = Math.random() < 0.5;
      send({ t: "first", chooser: iChoose ? "host" : "guest" });
      startRound(iChoose);
    }
    if (S.live) { refreshStatus(); renderPlay(); }
    showConn();
  } else if (m.t === "full") {
    homeError("That room already has two players.");
  } else if (m.t === "first" && !S.host && !S.met) {
    S.met = true;
    startRound(m.chooser === "guest");
  } else if (m.t === "word" && !S.iChoose && Number.isInteger(m.len) && m.len >= 3 && m.len <= 14) {
    if (!S.live) wordArrived(m);
  } else if (m.t === "try" && S.iChoose && Number.isInteger(m.n)) {
    answerTry(m);
  } else if (m.t === "reply" && !S.iChoose && Number.isInteger(m.n)) {
    takeReply(m);
  } else if (m.t === "next") {
    S.foeNext = true;
    tryNext();
  }
}

// ---------- rounds ----------
function startRound(iChoose) {
  Object.assign(S, {
    iChoose, live: false, over: false, word: "", len: 0, hint: "", shown: [], tried: [], left: TRIES, moves: [],
    pending: null, iNext: false, foeNext: false,
  });
  $("end").classList.remove("on");
  $("secretIn").value = "";
  $("hintIn").value = "";
  $("guessIn").value = "";
  $("pickErr").textContent = "";
  $("guessErr").textContent = "";
  if (iChoose) {
    $("pickIntro").textContent = `Choose a word for ${S.foe} to fill in. It's up to you to spell it right.`;
    show("pick");
    $("secretIn").focus();
  } else {
    $("waitingNote").textContent = `${S.foe} is choosing a word…`;
    show("waiting");
  }
  showConn();
}

function chooseWord() {
  const word = cleanWord($("secretIn").value);
  if (word.length < 3) { $("pickErr").textContent = "Your word needs at least three letters."; return; }
  S.word = word;
  S.hint = $("hintIn").value.trim().slice(0, 40);
  S.shown = Array(word.length).fill("");
  S.live = true;
  send({ t: "word", len: word.length, hint: S.hint });
  chime([392, 523]);
  show("play");
  refreshStatus();
  renderPlay();
}

function wordArrived(m) {
  S.len = m.len;
  S.hint = String(m.hint || "").slice(0, 40);
  S.shown = Array(m.len).fill("");
  S.live = true;
  chime([392, 523]);
  show("play");
  refreshStatus();
  renderPlay();
  nudge();
}

// The chooser's computer works out every result, so a repeat of the same move just gets the same answer.
function answerTry(m) {
  const seen = S.moves[m.n];
  if (seen) { send({ t: "reply", n: m.n, ...seen }); return; }
  if (!S.live || m.n !== S.moves.length) return;
  let reply;
  if (isLetter(m.letter) && !S.tried.includes(m.letter)) {
    const at = [...S.word].flatMap((ch, i) => ch === m.letter ? [i] : []);
    S.tried.push(m.letter);
    at.forEach(i => { S.shown[i] = m.letter; });
    if (!at.length) S.left--;
    reply = { letter: m.letter, at };
  } else if (isWord(m.guess)) {
    const right = m.guess === S.word;
    if (right) S.shown = [...S.word]; else S.left--;
    reply = { guess: m.guess, right };
  } else return;
  const solved = S.shown.every(Boolean);
  if (solved || S.left === 0) reply.end = { solved, word: S.word, left: S.left };
  S.moves[m.n] = reply;
  send({ t: "reply", n: m.n, ...reply });
  if (reply.end) return endRound(reply.end);
  reply.at && reply.at.length ? chime([523]) : ripple();
  setStatus(reply.letter ? `${S.foe} tried ${reply.letter}.` : `${S.foe} guessed ${reply.guess}.`);
  renderPlay();
}

function takeReply(m) {
  if (!S.pending || S.pending.n !== m.n) return;
  S.pending = null;
  S.moves[m.n] = true;
  if (isLetter(m.letter) && Array.isArray(m.at)) {
    const at = m.at.filter(i => Number.isInteger(i) && i >= 0 && i < S.len);
    S.tried.push(m.letter);
    at.forEach(i => { S.shown[i] = m.letter; });
    if (!at.length) S.left--;
    at.length ? chime([523]) : ripple();
    setStatus(at.length ? `${m.letter} is in the word. Your turn.` : `No ${m.letter}. Your turn.`, "mine");
  } else if (isWord(m.guess)) {
    if (!m.right) { S.left--; ripple(); setStatus(`Not ${m.guess}. Your turn.`, "mine"); }
  }
  const end = m.end;
  if (end && isWord(end.word)) {
    S.word = end.word;
    S.shown = [...end.word];
    return endRound({ solved: !!end.solved, word: end.word, left: Math.max(0, Math.min(TRIES, S.left)) });
  }
  renderPlay();
}

function endRound(end) {
  S.live = false;
  S.over = true;
  const points = end.solved ? end.left : FAIL_POINTS;
  const iScored = end.solved !== S.iChoose;
  if (iScored) S.mine += points; else S.theirs += points;
  iScored ? chime([523, 659, 784, 1047]) : chime([392, 330, 262]);
  const name = end.solved ? (S.iChoose ? `${S.foe} solved it` : "You solved it") : (S.iChoose ? `${S.foe} ran out of tries` : "You ran out of tries");
  $("endTitle").textContent = name;
  $("endNote").textContent = `The word was ${end.word}. ${iScored ? "You score" : `${S.foe} scores`} ${points}. It's ${S.mine} to ${S.theirs}.`;
  $("againBtn").disabled = false;
  $("againBtn").textContent = "Next round";
  setStatus(`${name}. The word was ${end.word}.`);
  renderPlay();
  $("end").classList.add("on");
}

function tryNext() {
  if (S.iNext && S.foeNext) { S.round++; startRound(!S.iChoose); }
  else if (S.foeNext && S.over) $("endNote").textContent += ` ${S.foe} is ready.`;
}

// ---------- guessing ----------
const myGo = () => S.live && !S.iChoose && !S.pending;

function sendLetter(letter) {
  if (!myGo() || S.tried.includes(letter) || !conn || !conn.open) return;
  $("guessErr").textContent = "";
  S.pending = { n: S.moves.length, letter };
  send({ t: "try", ...S.pending });
  renderPlay();
}

function sendWord() {
  const guess = cleanWord($("guessIn").value);
  if (!myGo() || !conn || !conn.open) return;
  if (guess.length !== S.len) { $("guessErr").textContent = `This word has ${S.len} letters.`; return; }
  $("guessErr").textContent = "";
  S.pending = { n: S.moves.length, guess };
  send({ t: "try", ...S.pending });
  $("guessIn").value = "";
  renderPlay();
}

function renderPlay() {
  const size = S.iChoose ? S.word.length : (S.word.length || S.len);
  $("blanks").replaceChildren(...Array.from({ length: size }, (_, i) => {
    const cell = document.createElement("span");
    cell.textContent = S.shown[i] || (S.iChoose ? S.word[i] : "");
    if (S.iChoose && !S.shown[i]) cell.className = "ghost";
    return cell;
  }));
  $("hint").textContent = S.hint ? `Hint: ${S.hint}` : "";
  const tries = document.createElement("i");
  tries.textContent = "x".repeat(TRIES - S.left);
  $("lives").replaceChildren(`${S.left} ${S.left === 1 ? "try" : "tries"} left `, tries);
  $("myScore").textContent = `You ${S.mine}`;
  $("foeScore").textContent = `${S.foe} ${S.theirs}`;
  $("guessPanel").hidden = S.iChoose;
  $("setterPanel").hidden = !S.iChoose;
  $("tried").textContent = S.tried.join(" ") || "None yet";
  $("guessIn").disabled = $("sendBtn").disabled = !myGo();
  $("alpha").replaceChildren(...[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(ch => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = ch;
    const used = S.tried.includes(ch);
    b.className = used ? (S.shown.includes(ch) ? "good" : "bad") : "";
    b.disabled = used || !myGo();
    b.onclick = () => sendLetter(ch);
    return b;
  }));
}

// ---------- screen text ----------
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function setStatus(text, kind = "") {
  const el = $("status");
  el.className = "status " + kind;
  clearTimeout(typing);
  if (stillMotion || document.hidden) { el.textContent = text; return; }
  let n = 0;
  (function type() {
    el.textContent = text.slice(0, ++n);
    if (n < text.length) typing = setTimeout(type, 16);
  })();
}

function refreshStatus() {
  if (!S.live) return;
  if (S.iChoose) setStatus(`${S.foe} is filling in your word…`);
  else setStatus("Your turn. Pick a letter.", "mine");
}

function nudge() {
  if (document.hidden) document.title = "Your turn! Blanks";
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "Blanks"; });

function showConn() {
  const on = conn && conn.open;
  document.querySelectorAll("[data-conn]").forEach(e => {
    const dot = document.createElement("i");
    dot.className = "dot" + (on ? "" : " off");
    e.replaceChildren(dot, on ? `With ${S.foe}` : "Reconnecting…");
  });
}

function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("on", s.id === id));
  window.scrollTo(0, 0);
}

// ---------- sound ----------
let audio = null, muted = store.get("blanks-muted") === "1";
function sound() {
  if (muted) return null;
  audio = audio || new (window.AudioContext || window.webkitAudioContext)();
  audio.resume();
  return audio;
}
function note(freq, at, length, level) {
  const ctx = sound();
  if (!ctx) return;
  const osc = ctx.createOscillator(), gain = ctx.createGain(), t = ctx.currentTime + at;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(level, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + length);
}
function ripple() {   // a single typewriter key
  const ctx = sound();
  if (!ctx) return;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
  buffer.getChannelData(0).forEach((_, i, d) => { d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3; });
  const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
  src.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.value = 1800;
  gain.gain.value = 0.3;
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start();
}
const chime = notes => { ripple(); notes.forEach((f, i) => note(f * 2, i * 0.12, 0.7, 0.05)); };   // key, then the carriage bell
const soundLabel = () => { $("soundBtn").textContent = muted ? "Sound off" : "Sound on"; };

// ---------- buttons ----------
const myName = () => { S.me = $("nameIn").value.trim().slice(0, 16); store.set("blanks-name", S.me); $("homeErr").textContent = ""; };
$("hostBtn").onclick = () => { myName(); hostRoom(); };
$("joinBtn").onclick = () => {
  myName();
  const code = $("codeIn").value.trim().toUpperCase();
  if (!/^[A-Z]+-\d{2}$/.test(code)) { $("homeErr").textContent = "Room codes look like QUILL-42."; return; }
  joinRoom(code);
};
$("codeIn").onkeydown = e => { if (e.key === "Enter") $("joinBtn").click(); };
$("copyBtn").onclick = async () => {
  const link = location.origin + location.pathname + "#" + S.code;
  try { await navigator.clipboard.writeText(link); $("copyBtn").textContent = "Copied!"; }
  catch { $("copyBtn").textContent = link; }
};
document.querySelectorAll("[data-leave]").forEach(b => { b.onclick = leave; });
for (const id of ["secretIn", "guessIn"]) $(id).oninput = e => { e.target.value = cleanWord(e.target.value); };
$("secretIn").onkeydown = e => { if (e.key === "Enter") chooseWord(); };
$("hintIn").onkeydown = e => { if (e.key === "Enter") chooseWord(); };
$("readyBtn").onclick = chooseWord;
$("surpriseBtn").onclick = () => {
  $("secretIn").value = SURPRISES[Math.floor(Math.random() * SURPRISES.length)];
  $("pickErr").textContent = "";
};
$("wordForm").onsubmit = e => { e.preventDefault(); sendWord(); };
$("againBtn").onclick = () => {
  S.iNext = true;
  send({ t: "next" });
  $("againBtn").disabled = true;
  $("againBtn").textContent = "Waiting…";
  tryNext();
};
$("lookBtn").onclick = () => $("end").classList.remove("on");
$("soundBtn").onclick = () => { muted = !muted; store.set("blanks-muted", muted ? "1" : "0"); soundLabel(); };
addEventListener("keydown", e => {   // on a computer, just press a letter
  if (e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
  const letter = e.key.toUpperCase();
  if (isLetter(letter) && $("play").classList.contains("on")) sendLetter(letter);
});

// ---------- start ----------
$("nameIn").value = store.get("blanks-name") || "";
const invite = decodeURIComponent(location.hash.slice(1)).toUpperCase();
if (/^[A-Z]+-\d{2}$/.test(invite)) $("codeIn").value = invite;
soundLabel();
