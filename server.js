
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
app.use(express.static(PUBLIC_DIR));

// Expose ICE (STUN/TURN) config to the client
app.get("/config", (_req, res) => {
  const stun = [{ urls: "stun:stun.l.google.com:19302" }];
  const { TURN_URL, TURN_USERNAME, TURN_PASSWORD } = process.env;
  const ice = [...stun];
  if (TURN_URL && TURN_USERNAME && TURN_PASSWORD) {
    ice.push({ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_PASSWORD });
  }
  res.json({ iceServers: ice });
});

// Catch-all so "/" (and any unknown route) serves your app
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// -----------------
// WebSocket signaling + matching (Omegle-style)
// -----------------
const server = createServer(app);
const wss = new WebSocketServer({ server });

const waiting = [];
const rooms = new Map();

function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

function matchUsers(a, b) {
  const roomId = uuid();
  rooms.set(roomId, { a, b });
  a.roomId = roomId; b.roomId = roomId;
  // "polite" side starts the offer
  send(a.ws, "matched", { roomId, peer: { screenName: b.screenName, native: b.native }, polite: true });
  send(b.ws, "matched", { roomId, peer: { screenName: a.screenName, native: a.native }, polite: false });
}

function isComplement(a, b) {
  // strict: each wants the other's native language
  return a.wantLang === b.native && b.wantLang === a.native;
}

function tryMatch(user) {
  const idx = waiting.findIndex(u => isComplement(user, u));
  if (idx >= 0) {
    const partner = waiting.splice(idx, 1)[0];
    matchUsers(user, partner);
  } else {
    waiting.push(user);
  }
}

function cleanup(u) {
  // remove from queue
  const i = waiting.findIndex(x => x.id === u.id);
  if (i >= 0) waiting.splice(i, 1);
  // notify peer if in a room
  if (u.roomId && rooms.has(u.roomId)) {
    const room = rooms.get(u.roomId);
    const peer = room.a.id === u.id ? room.b : room.a;
    send(peer.ws, "peer-left", {});
    rooms.delete(u.roomId);
  }
}

wss.on("connection", (ws) => {
  const user = { id: uuid(), ws };
  send(ws, "welcome", { userId: user.id });

  ws.on("message", (raw) => {
    let msg = {};
    try { msg = JSON.parse(raw.toString()); } catch {}

    const { type } = msg;

    if (type === "hello") {
      user.screenName = String(msg.screenName || "Guest").slice(0, 24);
      user.native     = String(msg.native || "").slice(0, 24);
      user.wantMode   = msg.wantMode === "hear" ? "hear" : "speak"; // not used in routing, but kept
      user.wantLang   = String(msg.wantLang || "").slice(0, 24);
      tryMatch(user);
      return;
    }

    if (type === "leave") { cleanup(user); return; }

    if (type === "signal-offer" || type === "signal-answer" || type === "signal-ice") {
      const room = rooms.get(user.roomId || "");
      if (!room) return;
      const peer = room.a.id === user.id ? room.b : room.a;
      send(peer.ws, type, { data: msg.data });
      return;
    }
  });

  ws.on("close", () => cleanup(user));
  ws.on("error", () => cleanup(user));
});

// -----------------
// Start server
// -----------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

