const socket = io();

const $ = (id) => document.getElementById(id);
const screens = {
  home: $("screen-home"),
  room: $("screen-room"),
};

let state = {
  myId: null,
  roomCode: null,
  isHost: false,
  isDrawer: false,
  phase: "lobby",
  myWord: null,
  brushColor: "#000000",
  brushSize: 6,
  isErasing: false,
};

const COLORS = [
  "#000000", "#ffffff", "#ff5577", "#ff9933", "#ffd633",
  "#3ddc97", "#4ad8ff", "#5e7cff", "#a55eff", "#ff3ea5",
  "#8b5a2b", "#c0c0c0",
];

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function showError(msg) {
  $("home-error").textContent = msg;
  setTimeout(() => ($("home-error").textContent = ""), 4000);
}

socket.on("connect", () => {
  state.myId = socket.id;
});

/* ---------- HOME ---------- */
$("btn-create").onclick = () => {
  const name = $("input-name").value.trim();
  if (!name) return showError("Enter a name first.");
  const difficulty = $("select-difficulty").value;
  socket.emit("room:create", { name, difficulty }, (res) => {
    if (!res.ok) return showError(res.error || "Failed");
    state.roomCode = res.code;
    enterRoom();
  });
};

$("btn-join").onclick = () => {
  const name = $("input-name").value.trim();
  const code = $("input-code").value.trim().toUpperCase();
  if (!name) return showError("Enter a name first.");
  if (!code) return showError("Enter a room code.");
  socket.emit("room:join", { code, name }, (res) => {
    if (!res.ok) return showError(res.error || "Failed");
    state.roomCode = res.code;
    enterRoom();
  });
};

$("input-code").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase();
});

function enterRoom() {
  $("room-code-show").textContent = state.roomCode;
  showScreen("room");
  buildColorPalette();
  setMobileTab("canvas");
  setupMobileTabs();
}

/* ---------- MOBILE TABS ---------- */
let activeMobileTab = "canvas";

function setupMobileTabs() {
  document.querySelectorAll(".mobile-tabs .tab").forEach((btn) => {
    btn.onclick = () => setMobileTab(btn.dataset.tab);
  });
}

function setMobileTab(tab) {
  activeMobileTab = tab;
  document.querySelectorAll(".mobile-tabs .tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  document.querySelector(".canvas-area").classList.toggle("mobile-active", tab === "canvas");
  document.querySelector(".players-panel").classList.toggle("mobile-active", tab === "players");
  document.querySelector(".chat-panel").classList.toggle("mobile-active", tab === "chat");
  if (tab === "chat") $("tab-chat-badge").classList.add("hidden");
}

$("btn-leave").onclick = () => location.reload();
$("btn-playagain").onclick = () => {
  $("modal-gameend").classList.add("hidden");
  if (state.isHost) socket.emit("room:start");
};

$("btn-start").onclick = () => socket.emit("room:start");

/* ---------- COLORS ---------- */
function buildColorPalette() {
  const wrap = $("colors");
  wrap.innerHTML = "";
  COLORS.forEach((c) => {
    const sw = document.createElement("div");
    sw.className = "color-swatch" + (c === state.brushColor ? " active" : "");
    sw.style.background = c;
    sw.onclick = () => {
      state.brushColor = c;
      state.isErasing = false;
      $("btn-eraser").classList.remove("active");
      [...wrap.children].forEach((x) => x.classList.remove("active"));
      sw.classList.add("active");
    };
    wrap.appendChild(sw);
  });
}

$("brush-size").oninput = (e) => (state.brushSize = +e.target.value);

$("btn-eraser").onclick = () => {
  state.isErasing = !state.isErasing;
  $("btn-eraser").classList.toggle("active", state.isErasing);
};

$("btn-clear").onclick = () => {
  if (!state.isDrawer) return;
  socket.emit("draw:clear");
};

$("btn-undo").onclick = () => {
  if (!state.isDrawer) return;
  socket.emit("draw:undo");
};

/* ---------- CANVAS ---------- */
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
ctx.lineCap = "round";
ctx.lineJoin = "round";

let drawing = false;
let lastPt = null;

function fitCanvas() {
  // Keep internal resolution at 800x600 for stable network coords
}

function getPos(e) {
  const r = canvas.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  const x = ((t.clientX - r.left) / r.width) * canvas.width;
  const y = ((t.clientY - r.top) / r.height) * canvas.height;
  return { x, y };
}

function pointerDown(e) {
  if (!state.isDrawer || state.phase !== "drawing") return;
  e.preventDefault();
  drawing = true;
  const p = getPos(e);
  lastPt = p;
  const stroke = {
    type: "begin",
    x: p.x,
    y: p.y,
    color: state.isErasing ? "#ffffff" : state.brushColor,
    size: state.isErasing ? state.brushSize * 2 : state.brushSize,
  };
  applyStroke(stroke);
  socket.emit("draw:stroke", stroke);
}

function pointerMove(e) {
  if (!drawing) return;
  e.preventDefault();
  const p = getPos(e);
  const stroke = {
    type: "draw",
    x: p.x,
    y: p.y,
    fromX: lastPt.x,
    fromY: lastPt.y,
    color: state.isErasing ? "#ffffff" : state.brushColor,
    size: state.isErasing ? state.brushSize * 2 : state.brushSize,
  };
  applyStroke(stroke);
  socket.emit("draw:stroke", stroke);
  lastPt = p;
}

function pointerUp(e) {
  if (!drawing) return;
  drawing = false;
  lastPt = null;
  const stroke = { type: "end" };
  socket.emit("draw:stroke", stroke);
}

canvas.addEventListener("mousedown", pointerDown);
canvas.addEventListener("mousemove", pointerMove);
canvas.addEventListener("mouseup", pointerUp);
canvas.addEventListener("mouseleave", pointerUp);
canvas.addEventListener("touchstart", pointerDown, { passive: false });
canvas.addEventListener("touchmove", pointerMove, { passive: false });
canvas.addEventListener("touchend", pointerUp);

function applyStroke(s) {
  if (s.type === "begin") {
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineTo(s.x + 0.01, s.y + 0.01);
    ctx.stroke();
  } else if (s.type === "draw") {
    ctx.beginPath();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.moveTo(s.fromX, s.fromY);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
  }
}

function clearCanvas() {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

clearCanvas();

socket.on("draw:stroke", (s) => applyStroke(s));
socket.on("draw:clear", () => clearCanvas());
socket.on("draw:replay", ({ strokes }) => {
  clearCanvas();
  strokes.forEach(applyStroke);
});

/* ---------- ROOM STATE ---------- */
socket.on("room:state", (rs) => {
  state.phase = rs.phase;
  state.isHost = rs.players.some((p) => p.id === state.myId && p.isHost);
  state.isDrawer = rs.drawerId === state.myId;

  $("word-display").textContent =
    rs.phase === "drawing"
      ? state.isDrawer && state.myWord
        ? state.myWord.toUpperCase()
        : rs.wordMask
      : rs.phase === "wordpick"
        ? "Picking word..."
        : rs.phase === "lobby"
          ? "Waiting for players"
          : rs.phase === "ended"
            ? "Game ended"
            : "";

  $("round-info").textContent =
    rs.phase === "lobby"
      ? `Lobby - ${rs.players.length} player${rs.players.length === 1 ? "" : "s"}`
      : `Round ${rs.round}/${rs.totalRounds}`;

  $("timer").textContent = rs.timer > 0 ? rs.timer + "s" : "--";

  renderPlayers(rs.players);

  $("btn-start").classList.toggle(
    "hidden",
    !(state.isHost && (rs.phase === "lobby" || rs.phase === "ended"))
  );

  $("draw-toolbar").classList.toggle("hidden", !(state.isDrawer && rs.phase === "drawing"));
  canvas.classList.toggle("disabled", !(state.isDrawer && rs.phase === "drawing"));

  const overlay = $("canvas-overlay");
  if (rs.phase === "lobby") {
    overlay.textContent = "Waiting for host to start...";
    overlay.classList.remove("hidden");
  } else if (rs.phase === "wordpick" && !state.isDrawer) {
    const drawerName = rs.players.find((p) => p.id === rs.drawerId)?.name || "?";
    overlay.textContent = `${drawerName} is picking a word...`;
    overlay.classList.remove("hidden");
  } else {
    overlay.classList.add("hidden");
  }

  const inp = $("chat-input");
  if (rs.phase === "drawing" && state.isDrawer) {
    inp.placeholder = "You're drawing - chat with guessers who got it right";
  } else if (rs.phase === "drawing") {
    inp.placeholder = "Type your guess...";
  } else {
    inp.placeholder = "Chat...";
  }
});

socket.on("tick", ({ timer }) => {
  $("timer").textContent = timer > 0 ? timer + "s" : "--";
});

let lastPlayers = [];
function renderPlayers(players) {
  lastPlayers = players;
  $("tab-players-count").textContent = players.length;
  const ul = $("players-list");
  ul.innerHTML = "";
  [...players]
    .sort((a, b) => b.score - a.score)
    .forEach((p) => {
      const li = document.createElement("li");
      if (p.isDrawing) li.classList.add("is-drawing");
      if (p.guessed) li.classList.add("guessed");
      const badges = [];
      if (p.isHost) badges.push('<span class="badge">HOST</span>');
      if (p.isDrawing) badges.push('<span class="badge" style="background:var(--accent-2);color:#0f1020">DRAW</span>');
      if (p.guessed) badges.push('<span class="badge" style="background:var(--good);color:#0f1020">GOT IT</span>');
      li.innerHTML = `
        <div class="player-name">${escapeHtml(p.name)}${p.id === state.myId ? " (you)" : ""} ${badges.join(" ")}</div>
        <div class="player-score">${p.score}</div>
      `;
      ul.appendChild(li);
    });
}

/* ---------- WORD PICK ---------- */
socket.on("word:choices", ({ words }) => {
  const modal = $("modal-wordpick");
  const wrap = $("word-choices");
  wrap.innerHTML = "";
  words.forEach((w) => {
    const div = document.createElement("div");
    div.className = "word-choice";
    div.textContent = w;
    div.onclick = () => {
      socket.emit("word:pick", { word: w });
      modal.classList.add("hidden");
    };
    wrap.appendChild(div);
  });
  modal.classList.remove("hidden");
});

socket.on("word:assigned", ({ word }) => {
  state.myWord = word;
  $("modal-wordpick").classList.add("hidden");
});

socket.on("guess:correct", ({ word, points }) => {
  addChatLine({ kind: "win", text: `You guessed it! "${word}" +${points}` });
});

/* ---------- ROUND END ---------- */
socket.on("round:end", ({ word, reason, roundScores }) => {
  state.myWord = null;
  $("roundend-title").textContent =
    reason === "all-guessed" ? "Everyone got it!" :
    reason === "drawer-left" ? "Drawer left" :
    "Time's up!";
  $("roundend-word").textContent = word;
  const ul = $("roundend-scores");
  ul.innerHTML = "";
  Object.entries(roundScores).forEach(([id, pts]) => {
    const li = document.createElement("li");
    const name = lastPlayers.find((p) => p.id === id)?.name || "?";
    li.innerHTML = `<span>${escapeHtml(name)}</span><strong>+${pts}</strong>`;
    ul.appendChild(li);
  });
  if (Object.keys(roundScores).length === 0) {
    ul.innerHTML = '<li style="justify-content:center;color:var(--muted)">Nobody scored</li>';
  }
  const modal = $("modal-roundend");
  modal.classList.remove("hidden");
  setTimeout(() => modal.classList.add("hidden"), 4500);
});

/* ---------- GAME END ---------- */
socket.on("game:end", ({ ranking }) => {
  const ol = $("gameend-ranking");
  ol.innerHTML = "";
  ranking.forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(r.name)}</span><strong>${r.score}</strong>`;
    ol.appendChild(li);
  });
  $("modal-gameend").classList.remove("hidden");
});

/* ---------- CHAT ---------- */
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $("chat-input");
  const text = inp.value.trim();
  if (!text) return;
  socket.emit("chat:send", { text });
  inp.value = "";
});

socket.on("chat:msg", (msg) => addChatLine(msg));

function addChatLine(msg) {
  const log = $("chat-log");
  const li = document.createElement("li");
  li.classList.add(msg.kind || "system");
  if (msg.kind === "player" || msg.kind === "team") {
    li.innerHTML = `<span class="name">${escapeHtml(msg.name)}:</span>${escapeHtml(msg.text)}`;
  } else {
    li.textContent = msg.text;
  }
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 200) log.removeChild(log.firstChild);
  if (activeMobileTab !== "chat" && window.matchMedia("(max-width: 900px)").matches) {
    $("tab-chat-badge").classList.remove("hidden");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

socket.on("disconnect", () => {
  addChatLine({ kind: "warn", text: "Disconnected from server. Refresh to retry." });
});
