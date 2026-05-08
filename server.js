import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORDS = JSON.parse(readFileSync(join(__dirname, "words.json"), "utf-8"));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(express.static(join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const ROUND_SECONDS = 80;
const WORD_PICK_SECONDS = 15;
const REVEAL_SECONDS = 6;
const ROUNDS_PER_GAME = 3;
const MIN_PLAYERS = 2;

const rooms = new Map();

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function pickWords(difficulty = "medium") {
  const pool = WORDS[difficulty] || WORDS.medium;
  const choices = new Set();
  while (choices.size < 3) choices.add(pool[Math.floor(Math.random() * pool.length)]);
  return [...choices];
}

function maskWord(word, revealedIdx) {
  return word
    .split("")
    .map((ch, i) => (ch === " " ? " " : revealedIdx.has(i) ? ch : "_"))
    .join(" ");
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    isHost: p.id === room.hostId,
    isDrawing: p.id === room.currentDrawerId,
    guessed: room.guessedThisRound.has(p.id),
  }));
}

function publicRoomState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    totalRounds: ROUNDS_PER_GAME,
    drawerId: room.currentDrawerId,
    players: publicPlayers(room),
    timer: room.timerEndsAt ? Math.max(0, Math.ceil((room.timerEndsAt - Date.now()) / 1000)) : 0,
    wordMask: room.wordMask,
    wordLength: room.currentWord ? room.currentWord.length : 0,
    difficulty: room.difficulty,
  };
}

function broadcastState(room) {
  io.to(room.code).emit("room:state", publicRoomState(room));
}

function systemMsg(room, text, kind = "info") {
  io.to(room.code).emit("chat:msg", { kind, text, ts: Date.now() });
}

function clearTimers(room) {
  if (room.tickInterval) clearInterval(room.tickInterval);
  if (room.phaseTimeout) clearTimeout(room.phaseTimeout);
  if (room.hintInterval) clearInterval(room.hintInterval);
  room.tickInterval = null;
  room.phaseTimeout = null;
  room.hintInterval = null;
}

function startTick(room) {
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.tickInterval = setInterval(() => {
    if (!rooms.has(room.code)) return clearInterval(room.tickInterval);
    io.to(room.code).emit("tick", {
      timer: Math.max(0, Math.ceil((room.timerEndsAt - Date.now()) / 1000)),
    });
  }, 1000);
}

function nextDrawer(room) {
  const ids = [...room.players.keys()];
  if (ids.length === 0) return null;
  const idx = ids.indexOf(room.currentDrawerId);
  return ids[(idx + 1) % ids.length];
}

function startRound(room) {
  clearTimers(room);
  room.guessedThisRound = new Set();
  room.strokes = [];
  room.currentWord = null;
  room.wordMask = "";
  room.revealedIdx = new Set();
  room.roundScores = new Map();

  if (room.players.size < MIN_PLAYERS) {
    room.phase = "lobby";
    systemMsg(room, "Need at least 2 players. Back to lobby.", "warn");
    broadcastState(room);
    return;
  }

  room.currentDrawerId = room.currentDrawerId
    ? nextDrawer(room)
    : [...room.players.keys()][0];

  room.drawersThisRound = (room.drawersThisRound || 0) + 1;

  if (room.drawersThisRound > room.players.size) {
    room.drawersThisRound = 1;
    room.round += 1;
  }

  if (room.round > ROUNDS_PER_GAME) return endGame(room);

  room.phase = "wordpick";
  room.wordChoices = pickWords(room.difficulty);
  room.timerEndsAt = Date.now() + WORD_PICK_SECONDS * 1000;

  io.to(room.currentDrawerId).emit("word:choices", { words: room.wordChoices });
  systemMsg(room, `${room.players.get(room.currentDrawerId).name} is picking a word...`);
  broadcastState(room);
  startTick(room);

  room.phaseTimeout = setTimeout(() => {
    if (room.phase === "wordpick") {
      const auto = room.wordChoices[Math.floor(Math.random() * room.wordChoices.length)];
      beginDrawing(room, auto);
    }
  }, WORD_PICK_SECONDS * 1000);
}

function beginDrawing(room, word) {
  clearTimers(room);
  room.currentWord = word.toLowerCase();
  room.revealedIdx = new Set();
  for (let i = 0; i < room.currentWord.length; i++) {
    if (room.currentWord[i] === " ") room.revealedIdx.add(i);
  }
  room.wordMask = maskWord(room.currentWord, room.revealedIdx);
  room.phase = "drawing";
  room.timerEndsAt = Date.now() + ROUND_SECONDS * 1000;

  io.to(room.currentDrawerId).emit("word:assigned", { word: room.currentWord });
  systemMsg(room, `Round ${room.round} - drawer chose a word. Start guessing!`);
  broadcastState(room);
  startTick(room);

  const totalReveals = Math.max(
    1,
    Math.min(
      Math.floor(room.currentWord.replace(/ /g, "").length / 2),
      Math.floor(ROUND_SECONDS / REVEAL_SECONDS) - 1
    )
  );
  let revealCount = 0;
  room.hintInterval = setInterval(() => {
    if (room.phase !== "drawing") return clearInterval(room.hintInterval);
    if (revealCount >= totalReveals) return clearInterval(room.hintInterval);
    const hidden = [];
    for (let i = 0; i < room.currentWord.length; i++) {
      if (!room.revealedIdx.has(i)) hidden.push(i);
    }
    if (hidden.length <= 1) return clearInterval(room.hintInterval);
    const pick = hidden[Math.floor(Math.random() * hidden.length)];
    room.revealedIdx.add(pick);
    room.wordMask = maskWord(room.currentWord, room.revealedIdx);
    revealCount += 1;
    broadcastState(room);
  }, Math.floor((ROUND_SECONDS * 1000) / (totalReveals + 1)));

  room.phaseTimeout = setTimeout(() => endDrawingPhase(room, "timeout"), ROUND_SECONDS * 1000);
}

function endDrawingPhase(room, reason) {
  if (room.phase !== "drawing") return;
  clearTimers(room);
  room.phase = "reveal";

  const drawer = room.players.get(room.currentDrawerId);
  if (drawer && room.guessedThisRound.size > 0) {
    const drawerBonus = Math.floor(
      [...room.roundScores.values()].reduce((a, b) => a + b, 0) / room.guessedThisRound.size / 2
    );
    drawer.score += drawerBonus;
    room.roundScores.set(drawer.id, drawerBonus);
  }

  io.to(room.code).emit("round:end", {
    word: room.currentWord,
    reason,
    roundScores: Object.fromEntries(room.roundScores),
  });
  broadcastState(room);

  room.phaseTimeout = setTimeout(() => startRound(room), 5000);
}

function endGame(room) {
  clearTimers(room);
  room.phase = "ended";
  const ranking = [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ id: p.id, name: p.name, score: p.score }));
  io.to(room.code).emit("game:end", { ranking });
  systemMsg(room, `Game over! Winner: ${ranking[0]?.name || "nobody"}`, "win");
  broadcastState(room);
}

function resetForNewGame(room) {
  for (const p of room.players.values()) p.score = 0;
  room.round = 1;
  room.drawersThisRound = 0;
  room.currentDrawerId = null;
  room.phase = "lobby";
  broadcastState(room);
}

function awardGuess(room, playerId) {
  const totalSecs = ROUND_SECONDS;
  const elapsed = totalSecs - Math.max(0, Math.ceil((room.timerEndsAt - Date.now()) / 1000));
  const remaining = Math.max(1, totalSecs - elapsed);
  const points = 50 + Math.floor((remaining / totalSecs) * 150);
  const player = room.players.get(playerId);
  if (!player) return 0;
  player.score += points;
  room.roundScores.set(playerId, points);
  room.guessedThisRound.add(playerId);
  return points;
}

io.on("connection", (socket) => {
  socket.data.name = null;
  socket.data.roomCode = null;

  socket.on("room:create", ({ name, difficulty }, cb) => {
    name = String(name || "").trim().slice(0, 16) || "Player";
    difficulty = ["easy", "medium", "hard"].includes(difficulty) ? difficulty : "medium";
    const code = makeRoomCode();
    const room = {
      code,
      hostId: socket.id,
      players: new Map(),
      phase: "lobby",
      round: 1,
      drawersThisRound: 0,
      currentDrawerId: null,
      currentWord: null,
      wordChoices: [],
      wordMask: "",
      revealedIdx: new Set(),
      timerEndsAt: 0,
      strokes: [],
      guessedThisRound: new Set(),
      roundScores: new Map(),
      difficulty,
      tickInterval: null,
      phaseTimeout: null,
      hintInterval: null,
    };
    room.players.set(socket.id, { id: socket.id, name, score: 0 });
    rooms.set(code, room);
    socket.join(code);
    socket.data.name = name;
    socket.data.roomCode = code;
    cb({ ok: true, code });
    broadcastState(room);
    systemMsg(room, `${name} created the room.`);
  });

  socket.on("room:join", ({ code, name }, cb) => {
    code = String(code || "").toUpperCase().trim();
    name = String(name || "").trim().slice(0, 16) || "Player";
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: "Room not found" });
    if (room.players.size >= 10) return cb({ ok: false, error: "Room full" });
    room.players.set(socket.id, { id: socket.id, name, score: 0 });
    socket.join(code);
    socket.data.name = name;
    socket.data.roomCode = code;
    cb({ ok: true, code });
    broadcastState(room);
    systemMsg(room, `${name} joined.`);
    if (room.strokes.length > 0 && room.phase === "drawing") {
      socket.emit("draw:replay", { strokes: room.strokes });
    }
  });

  socket.on("room:start", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== "lobby" && room.phase !== "ended") return;
    if (room.players.size < MIN_PLAYERS) {
      systemMsg(room, "Need 2+ players to start.", "warn");
      return;
    }
    resetForNewGame(room);
    startRound(room);
  });

  socket.on("word:pick", ({ word }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "wordpick") return;
    if (socket.id !== room.currentDrawerId) return;
    if (!room.wordChoices.includes(word)) return;
    beginDrawing(room, word);
  });

  socket.on("draw:stroke", (stroke) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "drawing") return;
    if (socket.id !== room.currentDrawerId) return;
    if (!stroke || typeof stroke !== "object") return;
    room.strokes.push(stroke);
    socket.to(room.code).emit("draw:stroke", stroke);
  });

  socket.on("draw:clear", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "drawing") return;
    if (socket.id !== room.currentDrawerId) return;
    room.strokes = [];
    io.to(room.code).emit("draw:clear");
  });

  socket.on("draw:undo", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "drawing") return;
    if (socket.id !== room.currentDrawerId) return;
    let removed = 0;
    for (let i = room.strokes.length - 1; i >= 0; i--) {
      if (room.strokes[i].type === "begin") {
        room.strokes.splice(i);
        removed = 1;
        break;
      }
    }
    if (removed) io.to(room.code).emit("draw:replay", { strokes: room.strokes });
  });

  socket.on("chat:send", ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    text = String(text || "").trim().slice(0, 200);
    if (!text) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    if (
      room.phase === "drawing" &&
      socket.id !== room.currentDrawerId &&
      !room.guessedThisRound.has(socket.id) &&
      text.toLowerCase() === room.currentWord
    ) {
      const pts = awardGuess(room, socket.id);
      io.to(room.code).emit("chat:msg", {
        kind: "guess",
        text: `${player.name} guessed the word! +${pts}`,
        ts: Date.now(),
      });
      socket.emit("guess:correct", { word: room.currentWord, points: pts });
      broadcastState(room);
      const nonDrawers = [...room.players.keys()].filter((id) => id !== room.currentDrawerId);
      if (room.guessedThisRound.size >= nonDrawers.length) endDrawingPhase(room, "all-guessed");
      return;
    }

    if (
      room.phase === "drawing" &&
      socket.id !== room.currentDrawerId &&
      !room.guessedThisRound.has(socket.id) &&
      room.currentWord
    ) {
      const guess = text.toLowerCase();
      const target = room.currentWord;
      if (guess.length >= 3 && Math.abs(guess.length - target.length) <= 2) {
        const dist = levenshtein(guess, target);
        if (dist > 0 && dist <= 2) {
          socket.emit("chat:msg", {
            kind: "close",
            text: `"${text}" is close!`,
            ts: Date.now(),
          });
          io.to(room.code).except(socket.id).emit("chat:msg", {
            kind: "player",
            name: player.name,
            text,
            ts: Date.now(),
          });
          return;
        }
      }
    }

    if (
      room.phase === "drawing" &&
      (socket.id === room.currentDrawerId || room.guessedThisRound.has(socket.id))
    ) {
      const audience = [...room.players.keys()].filter(
        (id) => id === room.currentDrawerId || room.guessedThisRound.has(id)
      );
      audience.forEach((id) => {
        io.to(id).emit("chat:msg", {
          kind: "team",
          name: player.name,
          text,
          ts: Date.now(),
        });
      });
      return;
    }

    io.to(room.code).emit("chat:msg", {
      kind: "player",
      name: player.name,
      text,
      ts: Date.now(),
    });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    room.players.delete(socket.id);
    systemMsg(room, `${player.name} left.`);

    if (room.players.size === 0) {
      clearTimers(room);
      rooms.delete(code);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = [...room.players.keys()][0];
    }

    if (room.currentDrawerId === socket.id && room.phase === "drawing") {
      systemMsg(room, "Drawer left. Round skipped.", "warn");
      endDrawingPhase(room, "drawer-left");
    } else {
      broadcastState(room);
    }
  });
});

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

httpServer.listen(PORT, () => {
  console.log(`SketchWars running on http://localhost:${PORT}`);
});
