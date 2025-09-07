let pc, ws, localStream, polite=false, makingOffer=false, ignoreOffer=false;
let lastHello=null;

const el = id => document.getElementById(id);
const status = msg => (el('status').textContent = msg);
const log = (...a)=>console.log('[LP]', ...a);

async function getIceServers(){
  try {
    const r = await fetch('/config');
    const j = await r.json();
    log('ICE servers:', j.iceServers);
    return j.iceServers || [{ urls:'stun:stun.l.google.com:19302' }];
  } catch(e){
    log('ICE /config failed; using STUN only', e);
    return [{ urls:'stun:stun.l.google.com:19302' }];
  }
}

async function startLocal(){
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
  el('localVideo').srcObject = localStream;
  return localStream;
}

async function createPC(){
  const iceServers = await getIceServers();
  pc = new RTCPeerConnection({ iceServers /*, iceTransportPolicy:'all' */});
  (await startLocal()).getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = e => { el('remoteVideo').srcObject = e.streams[0]; };

  pc.onicecandidate = ({candidate}) => {
    if (candidate) ws?.send(JSON.stringify({ type:'signal-ice', data:candidate }));
  };

  pc.oniceconnectionstatechange = () => {
    log('iceConnectionState=', pc.iceConnectionState);
    status(`ICE: ${pc.iceConnectionState}`);
    if (['failed','disconnected'].includes(pc.iceConnectionState)) {
      tryIceRestart();
      // fallback full reset after a short delay
      setTimeout(() => {
        if (pc && ['failed','disconnected'].includes(pc.iceConnectionState)) {
          fullResetAndRejoin();
        }
      }, 5000);
    }
  };
  pc.onconnectionstatechange = () => {
    log('connectionState=', pc.connectionState);
    status(`Peer: ${pc.connectionState}`);
  };

  pc.onnegotiationneeded = async ()=>{
    try{
      makingOffer = true;
      const offer = await pc.createOffer({ iceRestart:false });
      await pc.setLocalDescription(offer);
      ws?.send(JSON.stringify({ type:'signal-offer', data:pc.localDescription }));
    } catch(e){ log('negotiation error', e); }
    finally{ makingOffer = false; }
  };

  // iOS: user gesture for audio
  el('enableAudio').onclick = () => {
    el('enableAudio').classList.remove('muted');
    el('remoteVideo').play().catch(()=>{});
    const ac = new AudioContext(); ac.resume().catch(()=>{});
  };

  return pc;
}

let restartInFlight=false;
async function tryIceRestart(){
  if (!pc || restartInFlight) return;
  restartInFlight = true;
  log('Attempting ICE restart…');
  try{
    const offer = await pc.createOffer({ iceRestart:true });
    await pc.setLocalDescription(offer);
    ws?.send(JSON.stringify({ type:'signal-offer', data:pc.localDescription }));
  } catch(e){ log('ICE restart error', e); }
  finally{ setTimeout(()=>restartInFlight=false, 2000); }
}

function connectWS(){
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => status('Connected to server. Waiting for partner…');
  ws.onclose = () => status('Disconnected');
  ws.onerror = e => log('WS error', e);

  ws.onmessage = async ev => {
    const msg = JSON.parse(ev.data || '{}');

    if (msg.type === 'welcome') return;

    if (msg.type === 'matched') {
      polite = !!msg.polite;
      log('Matched. polite=', polite, 'peer=', msg.peer);
      status('Matched. Setting up media…');
      await createPC();
      return;
    }

    if (!pc) return;

    if (msg.type === 'signal-offer') {
      const offerCollision = (makingOffer || pc.signalingState !== 'stable');
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return;

      await pc.setRemoteDescription(msg.data);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws?.send(JSON.stringify({ type:'signal-answer', data:pc.localDescription }));
      return;
    }

    if (msg.type === 'signal-answer') {
      await pc.setRemoteDescription(msg.data);
      return;
    }

    if (msg.type === 'signal-ice') {
      try { await pc.addIceCandidate(msg.data); }
      catch(e){ if (!ignoreOffer) log('addIceCandidate failed', e); }
      return;
    }

    if (msg.type === 'peer-left') {
      status('Partner left. Click “Find a partner” to match again.');
      try{ pc.close(); }catch{}
      pc = null;
      el('remoteVideo').srcObject = null;
    }
  };
}

async function join(){
  await startLocal();
  if (!ws || ws.readyState !== WebSocket.OPEN) connectWS();

  lastHello = {
    type:'hello',
    screenName: (el('screenName').value || 'Guest').slice(0,24),
    native: el('native').value,
    wantMode: el('wantMode').value,
    wantLang: el('wantLang').value
  };

  const trySend = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(lastHello));
      status('Waiting for a complementary partner…');
    } else {
      setTimeout(trySend, 200);
    }
  };
  trySend();
}

function leave(){
  try{ ws?.send(JSON.stringify({ type:'leave' })); }catch{}
  try{ pc?.close(); }catch{}
  pc = null;
  status('Left queue / call.');
}

function fullResetAndRejoin(){
  log('Full reset & rejoin');
  try{ pc?.close(); }catch{}
  pc = null;
  try{ ws?.close(); }catch{}
  connectWS();
  if (lastHello) {
    setTimeout(() => {  // small delay to ensure ws is open
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(lastHello));
        status('Reattempting connection…');
      }
    }, 400);
  }
}

document.getElementById('join').onclick = join;
document.getElementById('leave').onclick = leave;
document.getElementById('enableAudio').onclick = () => {
  document.getElementById('remoteVideo').play().catch(()=>{});
  const ac = new AudioContext(); ac.resume().catch(()=>{});
};
// Optional manual reconnect button if you want to add one in HTML:
// document.getElementById('reconnect').onclick = fullResetAndRejoin;
