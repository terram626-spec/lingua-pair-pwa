
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";

const app = express();
app.use(express.static("public"));

// Provide ICE servers (STUN by default; add TURN via env)
app.get("/config", (req, res) => {
  const stun = [{ urls: "stun:stun.l.google.com:19302" }];
  const turnUrl = process.env.TURN_URL;
  const turnUser = process.env.TURN_USERNAME;
  const turnPass = process.env.TURN_PASSWORD;
  const ice = [...stun];
  if (turnUrl && turnUser && turnPass) {
    ice.push({ urls: turnUrl, username: turnUser, credential: turnPass });
  }
  res.json({ iceServers: ice });
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

// In-memory state
const waiting = [];
const rooms = new Map();

function send(ws, type, payload={}) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

function matchUsers(a,b){
  const roomId = uuid();
  rooms.set(roomId,{a,b});
  a.roomId=roomId; b.roomId=roomId;
  const peerA = { screenName: b.screenName, native: b.native };
  const peerB = { screenName: a.screenName, native: a.native };
  send(a.ws,"matched",{roomId,peer:peerA,polite:true});
  send(b.ws,"matched",{roomId,peer:peerB,polite:false});
}

function isComplement(a,b){
  // A wants to practice a.wantLang with a native speaker; complement if other is native in that language
  // and vice versa (their wantLang equals my native). Mode is not used for routing beyond intent.
  return a.wantLang === b.native && b.wantLang === a.native;
}

function tryMatch(user){
  const idx=waiting.findIndex(u=>isComplement(user,u));
  if(idx>=0){const partner=waiting.splice(idx,1)[0];matchUsers(user,partner);} else waiting.push(user);
}

function cleanup(u){
  const i=waiting.findIndex(x=>x.id===u.id); if(i>=0) waiting.splice(i,1);
  if(u.roomId && rooms.has(u.roomId)){
    const room=rooms.get(u.roomId);
    const peer=room.a.id===u.id?room.b:room.a;
    send(peer.ws,"peer-left",{});
    rooms.delete(u.roomId);
  }
}

wss.on("connection", ws=>{
  const user={id:uuid(),ws};
  ws.on("message",raw=>{
    let msg={}; try{msg=JSON.parse(raw.toString());}catch{}
    const type = msg.type;
    if(type==="hello"){
      user.screenName=String(msg.screenName||"Guest").slice(0,24);
      user.native=String(msg.native||"").slice(0,24);
      user.wantMode=msg.wantMode==="hear"?"hear":"speak";
      user.wantLang=String(msg.wantLang||"").slice(0,24);
      tryMatch(user);
    }
    if(["signal-offer","signal-answer","signal-ice"].includes(type)){
      const room=rooms.get(user.roomId||"");
      if(!room)return;
      const peer=room.a.id===user.id?room.b:room.a;
      send(peer.ws,type,{data:msg.data});
    }
    if(type==="leave"){ cleanup(user); }
  });
  ws.on("close",()=>cleanup(user));
  ws.on("error",()=>cleanup(user));
  send(ws,"welcome",{userId:user.id});
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log("Server running on http://localhost:"+PORT));
