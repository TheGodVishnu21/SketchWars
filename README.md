# SketchWars

Multiplayer draw-and-guess party game. Like skribbl.io, runs in the browser.

## What it does
- Create a room, share the 5-letter code with friends.
- Each round one player draws a word, others guess in chat.
- Faster guess = more points. Bonus for the drawer when others guess.
- 3 rounds per game (each player draws once per round). Highest score wins.
- Hints: server gradually reveals letters as the timer ticks down.
- "Close" guesses (1-2 letter typos) are flagged privately to the guesser.

## Setup

```bash
cd SketchWars
npm install
npm start
```

Open `http://localhost:3000`. Share `http://<your-LAN-ip>:3000` with friends on the same network, or use ngrok / cloudflared for internet play.

```bash
# Tunnel options:
npx localtunnel --port 3000
# or
cloudflared tunnel --url http://localhost:3000
```

## Stack
- Node.js + Express + Socket.IO (authoritative server)
- HTML5 Canvas + vanilla JS (no framework)

## Files
- `server.js` — game loop, rooms, scoring, stroke broadcast
- `words.json` — word bank (easy / medium / hard)
- `public/index.html`, `style.css`, `client.js` — UI + canvas + socket client

## Controls (when drawing)
- 12-color palette + brush size slider
- Eraser, Undo (last stroke), Clear

## Game rules
- Min 2 players, max 10 per room
- Round timer: 80s drawing, 15s word pick
- Points: 50 base + up to 150 based on speed
- Drawer gets average of guesser scores / 2 as bonus

Have fun. Roast your friends' art.
