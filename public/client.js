let pc, ws, localStream, polite = false, makingOffer = false, ignoreOffer = false;

const el = id => document.getElementById(id);
const status = msg => (el('status').textContent = msg);

async function getIceServers() {
  try {
    const r = await fetch('/config');
    return (await r.json()).iceServers || [{ urls:'stun:stun.l.google.com:19302' }];
  } catch {
    return [{ urls:'stun:stun.l.google.com:19302' }];
  }
}

async function startLocal() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
  el('localVideo').srcObject = localStream;
  return localStream;
}

async function createPC() {
  const iceServers = await getIceServers();
  pc = new RTCPeerConnection({ iceServers });
  (await startLocal()).getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = (e) => {
    const [stream] = e.streams;
    el('remoteVideo').srcObject = stream;
    el('enableAudio').onclick = () => {
      el('enableAudio').classList.remove('muted');
      el('remoteVideo').play().catch(()=>{});
      const a = new AudioContext(); a.resume().catch(()=>{});
    };
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) ws.send(JSON.stringify({ type:'signal-ice', data:candidate }));
  };

  pc.onconnectionstatechange = () => status(`Peer: ${pc.connectionState}`);

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type:'signal-offer', data:pc.localDescription }));
    } catch (e) { console.error(e); }
    finally { makingOffer = false; }
  };

  return pc;
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => status('Connected to server. Waiting for partner…');
  ws.onclose = () => status('Disconnected');
  ws.onerror = (e) => console.error('WS error', e);

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data || '{}');
    if (msg.type === 'welcome') return;

    if (msg.type === 'matched') {
      polite = !!msg.polite;
      status(`Matched with ${msg?.peer?.screenName || 'partner'} (${msg?.peer?.native||''}). Polite=${polite}`);
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
      ws.send(JSON.stringify({ type:'signal-answer', data:pc.localDescription }));
      return;
    }

    if (msg.type === 'signal-answer') {
      await pc.setRemoteDescription(msg.data);
      return;
    }

    if (msg.type === 'signal-ice') {
      try { await pc.addIceCandidate(msg.data); }
      catch (e) { if (!ignoreOffer) console.error('Failed to add ICE', e); }
    }

    if (msg.type === 'peer-left') {
      status('Partner left. Click “Find a partner” to match again.');
      pc.close(); pc = null;
      el('remoteVideo').srcObject = null;
    }
  };
}

async function join() {
  await startLocal();
  if (!ws || ws.readyState !== WebSocket.OPEN) connectWS();

  const payload = {
    type:'hello',
    screenName: el('screenName').value || 'Guest',
    native: el('native').value,
    wantMode: el('wantMode').value,
    wantLang: el('wantLang').value
  };

  const trySend = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      status('Waiting for a complementary partner…');
    } else {
      setTimeout(trySend, 200);
    }
  };
  trySend();
}

function leave() {
  try { ws?.send(JSON.stringify({ type:'leave' })); } catch {}
  try { pc?.close(); } catch {}
  pc = null;
  status('Left queue / call.');
}

document.getElementById('join').onclick = join;
document.getElementById('leave').onclick = leave;
