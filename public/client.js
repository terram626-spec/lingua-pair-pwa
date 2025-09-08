let pc, ws, localStream;
let polite=false, makingOffer=false, ignoreOffer=false;
let pendingCandidates=[];
let wsTimer=null, wsReconnectDelay=800, wsShouldReconnect=true;
let joinInFlight=false, matched=false, hardFailTimer=null;
let lastHello=null;

const el = id => document.getElementById(id);
const status = m => (el('status').textContent = m);
const log = (...a)=>console.log('[LP]', ...a);

async function getIceServers(){
  try{ const r=await fetch('/config'); const j=await r.json(); log('ICE servers:', j.iceServers); return j.iceServers||[{urls:'stun:stun.l.google.com:19302'}]; }
  catch{ return [{urls:'stun:stun.l.google.com:19302'}]; }
}

async function startLocal(){
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
  el('localVideo').srcObject = localStream;
  return localStream;
}

async function buildPC(forceRelay=false){
  const iceServers = await getIceServers();
  const cfg = { iceServers };
  if (forceRelay) cfg.iceTransportPolicy = 'relay';
  const next = new RTCPeerConnection(cfg);

  (await startLocal()).getTracks().forEach(t => next.addTrack(t, localStream));

  next.ontrack = e => { el('remoteVideo').srcObject = e.streams[0]; };

  next.onicecandidate = ({candidate})=>{
    if (candidate) ws?.send(JSON.stringify({type:'signal-ice', data:candidate}));
  };

  next.oniceconnectionstatechange = ()=>{
    log('iceConnectionState=', next.iceConnectionState);
    status(`ICE: ${next.iceConnectionState}`);
    if (next.iceConnectionState==='connected'){
      clearTimeout(hardFailTimer);
      wsReconnectDelay = 800;
    }
    if (['failed','disconnected'].includes(next.iceConnectionState)){
      tryIceRestart();
      clearTimeout(hardFailTimer);
      hardFailTimer = setTimeout(()=>fallbackRelay(), 7000);
    }
  };

  next.onconnectionstatechange = ()=>{
    log('connectionState=', next.connectionState);
    status(`Peer: ${next.connectionState}`);
  };

  next.onnegotiationneeded = async ()=>{
    try{
      makingOffer = true;
      const offer = await next.createOffer({iceRestart:false});
      await next.setLocalDescription(offer);
      ws?.send(JSON.stringify({type:'signal-offer', data:next.localDescription}));
    }finally{ makingOffer=false; }
  };

  return next;
}

async function createPC(){
  pc?.close?.();
  pendingCandidates=[];
  matched = true;
  clearTimeout(hardFailTimer);
  pc = await buildPC(false);
  hardFailTimer = setTimeout(()=>fallbackRelay(), 7000);
}

async function fallbackRelay(){
  if (!pc || pc.iceConnectionState==='connected') return;
  log('FALLBACK: forcing TURN only');
  const old = pc;
  try{ old.close(); }catch{}
  pendingCandidates=[];
  pc = await buildPC(true);
  // kick a restart offer
  try{
    const offer = await pc.createOffer({iceRestart:true});
    await pc.setLocalDescription(offer);
    ws?.send(JSON.stringify({type:'signal-offer', data:pc.localDescription}));
  }catch(e){ log('relay offer error', e); }
}

let restarting=false;
async function tryIceRestart(){
  if (!pc || restarting) return;
  restarting = true;
  log('Attempting ICE restart…');
  try{
    const offer = await pc.createOffer({iceRestart:true});
    await pc.setLocalDescription(offer);
    ws?.send(JSON.stringify({type:'signal-offer', data:pc.localDescription}));
  }catch(e){ log('ICE restart error', e); }
  finally{ setTimeout(()=>restarting=false, 1500); }
}

function connectWS(){
  const proto = location.protocol==='https:'?'wss':'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = ()=>{
    status('Connected to server.');
    if (wsTimer) clearInterval(wsTimer);
    wsTimer = setInterval(()=>{ try{ ws.send(JSON.stringify({type:'ping'})); }catch{} }, 20000);
    if (lastHello) setTimeout(()=>{ try{ ws.send(JSON.stringify(lastHello)); }catch{} }, 150);
    wsReconnectDelay = 800; // reset backoff
  };
  ws.onclose = ()=>{
    if (wsTimer) clearInterval(wsTimer);
    if (!wsShouldReconnect) return;
    status('Disconnected — reconnecting…');
    setTimeout(connectWS, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay*1.8, 15000);
  };
  ws.onerror = e => log('WS error', e);

  ws.onmessage = async ev=>{
    const msg = JSON.parse(ev.data||'{}');
    if (msg.type==='welcome') return;

    if (msg.type==='matched'){
      if (matched) return; // already matched; ignore duplicate
      polite = !!msg.polite;
      log('Matched. polite=',polite,'peer=',msg.peer);
      await createPC();
      return;
    }

    if (!pc) return;

    if (msg.type==='signal-offer'){
      const offerCollision = (makingOffer || pc.signalingState!=='stable');
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return;

      await pc.setRemoteDescription(msg.data);
      for (const c of pendingCandidates.splice(0)) {
        try { await pc.addIceCandidate(c); } catch(e){ log('flush addIceCandidate failed', e); }
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws?.send(JSON.stringify({type:'signal-answer', data:pc.localDescription}));
      return;
    }

    if (msg.type==='signal-answer'){
      await pc.setRemoteDescription(msg.data);
      for (const c of pendingCandidates.splice(0)) {
        try { await pc.addIceCandidate(c); } catch(e){ log('flush addIceCandidate failed', e); }
      }
      return;
    }

    if (msg.type==='signal-ice'){
      if (!pc.remoteDescription) pendingCandidates.push(msg.data);
      else {
        try { await pc.addIceCandidate(msg.data); }
        catch(e){ log('addIceCandidate failed', e); }
      }
      return;
    }

    if (msg.type==='peer-left'){
      status('Partner left. Click “Find a partner” to match again.');
      try{ pc.close(); }catch{}
      pc=null; matched=false; pendingCandidates=[];
      el('remoteVideo').srcObject=null;
    }
  };
}

async function join(){
  if (joinInFlight) return;
  joinInFlight = true;
  await startLocal();
  if (!ws || ws.readyState!==WebSocket.OPEN) connectWS();

  lastHello = {
    type:'hello',
    screenName: (el('screenName').value||'Guest').slice(0,24),
    native: el('native').value,
    wantMode: el('wantMode').value,
    wantLang: el('wantLang').value
  };

  const sendHello=()=>{
    if (ws.readyState===WebSocket.OPEN){
      ws.send(JSON.stringify(lastHello));
      status('Waiting for a complementary partner…');
      joinInFlight = false;
    } else setTimeout(sendHello, 150);
  };
  sendHello();
}

function leave(){
  wsShouldReconnect = false;
  try{ ws?.send(JSON.stringify({type:'leave'})); }catch{}
  try{ ws?.close(); }catch{}
  try{ pc?.close(); }catch{}
  pc=null; ws=null; matched=false; pendingCandidates=[];
  clearInterval(wsTimer); wsTimer=null;
  clearTimeout(hardFailTimer);
  status('Left queue / call.');
}

document.getElementById('join').onclick = join;
document.getElementById('leave').onclick = leave;
document.getElementById('enableAudio').onclick = ()=>{
  document.getElementById('remoteVideo').play().catch(()=>{});
  const ac = new AudioContext(); ac.resume().catch(()=>{});
};
