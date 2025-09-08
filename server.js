import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
app.use(express.static(PUBLIC_DIR));

// ---------- ICE config route ----------
app.get("/config", (_req, res) => {
  const stun = [{ urls: "stun:stun.l.google.com:19302" }];

  // Support both TURN_URL (single) and TURN_URLS (comma-separated)
  const { TURN_URL, TURN_URLS, TURN_USERNAME, TURN_PASSWORD } = process.env;

  const ice = [...stun];
  const urlsText = TURN_URLS?.trim() || TURN_URL?.trim() || "";
  if (urlsText && TURN_USERNAME && TURN_PASSWORD) {
    urlsText.split(",").map(u => u.trim()).filter(Boolean).forEach(u => {
      ice.push({ urls: u, username: TURN_USERNAME, credential: TURN_PASSWORD });
    });
  }
  res.json({ iceServers: ice });
});

// ---------- Catch-all ----------
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ---------- WebSocket signaling ----------
const server = createServer(app);
const wss = new WebSocketServer({ server });

const waiting = [];
const rooms   = new Map();
function send(ws, type, payload={}) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}
function isComplement(a,b){ return a.wantLang === b.native && b.wantLang === a.native; }
function matchUsers(a,b){
  const roomId = uuid();
  rooms.set(roomId, { a, b });
  a.roomId = roomId; b.roomId = roomId;
  send(a.ws, "matched", { roomId, peer:{screenName:b.screenName,native:b.native}, polite:true });
  send(b.ws, "matched", { roomId, peer:{screenName:a.screenName,native:a.native}, polite:false });
}
function tryMatch(user){
  const i = waiting.findIndex(u => isComplement(user,u));
  if (i >= 0) matchUsers(user, waiting.splice(i,1)[0]);
  else waiting.push(user);
}
function cleanup(u){
  const i = waiting.findIndex(x => x.id === u.id);
  if (i >= 0) waiting.splice(i,1);
  if (u.roomId && rooms.has(u.roomId)){
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

    if (type === "hello"){
      user.screenName = String(msg.screenName || "Guest").slice(0,24);
      user.native     = String(msg.native || "").slice(0,24);
      user.wantMode   = msg.wantMode === "hear" ? "hear" : "speak";
      user.wantLang   = String(msg.wantLang || "").slice(0,24);
      tryMatch(user);
      return;
    }

    if (type === "signal-offer" || type === "signal-answer" || type === "signal-ice"){
      const room = rooms.get(user.roomId || "");
      if (!room) return;
      const peer = room.a.id === user.id ? room.b : room.a;
      send(peer.ws, type, { data: msg.data });
      return;
    }

    if (type === "leave"){ cleanup(user); }
  });

  ws.on("close", () => cleanup(user));
  ws.on("error", () => cleanup(user));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
