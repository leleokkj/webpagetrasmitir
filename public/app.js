// language: JavaScript, file: public/app.js, target: modern browsers with WebRTC (getDisplayMedia)
// Model: broadcaster initiates one RTCPeerConnection per viewer. Server relays SDP/ICE only.

const $ = (s) => document.querySelector(s);

const params = new URLSearchParams(location.search);
const initialRoom = (params.get('room') || location.hash.slice(1) || 'lobby').trim() || 'lobby';

// Public STUN gets you across most NATs on the same/simple networks.
// Add a TURN server here for symmetric-NAT / corporate networks.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

let ws = null;
let myId = null;
let myName = params.get('name') || ('user-' + Math.floor(1000 + Math.random() * 9000));
let room = initialRoom;
let sharing = false;
let localStream = null;
let reconnecting = false;

// peerId -> { name, pc, stream, pendingIce: [] }
const peers = new Map();
// peerId -> tile element
const tiles = new Map();

// ---------- UI helpers -------------------------------------------------------
function setMe() {
  $('#meLabel').textContent = `${myName} · ${sharing ? 'sharing' : 'viewing'}`;
}

function upsertTile(id, label, live) {
  let tile = tiles.get(id);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = `<video autoplay playsinline></video><div class="tag"></div>`;
    $('#stage').appendChild(tile);
    tiles.set(id, tile);
  }
  const tag = tile.querySelector('.tag');
  tag.textContent = label;
  tag.classList.toggle('live', !!live);
  refreshEmpty();
  return tile.querySelector('video');
}

function removeTile(id) {
  const tile = tiles.get(id);
  if (tile) { tile.remove(); tiles.delete(id); }
  refreshEmpty();
}

function refreshEmpty() {
  $('#emptyState').style.display = tiles.size ? 'none' : 'grid';
}

function renderRoster() {
  const ul = $('#roster');
  ul.innerHTML = '';
  const self = document.createElement('li');
  self.className = sharing ? 'sharing' : '';
  self.innerHTML = `<span class="dot"></span><span class="who">${escapeHtml(myName)} (you)</span>` +
    (sharing ? '<span class="badge">sharing</span>' : '');
  ul.appendChild(self);

  for (const [id, p] of peers) {
    const li = document.createElement('li');
    li.className = p.sharing ? 'sharing' : '';
    li.innerHTML = `<span class="dot"></span><span class="who">${escapeHtml(p.name)}</span>` +
      (p.sharing ? '<span class="badge">sharing</span>' : '');
    ul.appendChild(li);
  }
  $('#peerCount').textContent = peers.size + 1;
}

function logSys(text) {
  const li = document.createElement('li');
  li.className = 'sys';
  li.textContent = text;
  $('#messages').appendChild(li);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function logChat(name, text, mine) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="name">${escapeHtml(name)}</span> `;
  li.appendChild(document.createTextNode(text));
  if (mine) li.style.color = '#dbdee1';
  $('#messages').appendChild(li);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- signaling --------------------------------------------------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    reconnecting = false;
    ws.send(JSON.stringify({ type: 'join', room, name: myName }));
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleSignal(msg);
  };

  ws.onclose = () => {
    logSys('disconnected — retrying…');
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(connect, 1500);
    }
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handleSignal(msg) {
  switch (msg.type) {
    case 'joined': {
      myId = msg.id;
      peers.clear();
      for (const p of msg.peers) {
        // We only track state here; a broadcaster (if any) will offer to us.
        peers.set(p.id, { name: p.name, sharing: !!p.sharing, pc: null, stream: null, pendingIce: [] });
      }
      logSys(`joined room "${msg.room}" as ${myName}`);
      renderRoster();
      setMe();
      break;
    }

    case 'peer-join': {
      peers.set(msg.id, { name: msg.name, sharing: false, pc: null, stream: null, pendingIce: [] });
      logSys(`${msg.name} joined`);
      renderRoster();
      // If we are the one sharing, wire the newcomer immediately.
      if (sharing) await offerTo(msg.id);
      break;
    }

    case 'peer-leave': {
      const p = peers.get(msg.id);
      if (p) {
        logSys(`${p.name} left`);
        if (p.pc) p.pc.close();
        peers.delete(msg.id);
        removeTile(msg.id);
        renderRoster();
      }
      break;
    }

    case 'sharing': {
      const p = peers.get(msg.id);
      if (p) { p.sharing = msg.on; renderRoster(); }
      if (!msg.on) removeTile(msg.id);
      break;
    }

    case 'offer':
      await receiveOffer(msg);
      break;

    case 'answer': {
      const p = peers.get(msg.from);
      if (p && p.pc) {
        await p.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        await flushIce(p);
      }
      break;
    }

    case 'ice': {
      const p = peers.get(msg.from);
      if (!p) break;
      if (p.pc && p.pc.remoteDescription) {
        try { await p.pc.addIceCandidate(msg.candidate); } catch {}
      } else {
        p.pendingIce.push(msg.candidate);
      }
      break;
    }

    case 'chat':
      logChat(msg.name, msg.text, msg.id === myId);
      break;

    default: break;
  }
}

// ---------- broadcaster: create one PC per viewer ----------------------------
async function offerTo(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;

  if (peer.pc) { peer.pc.close(); }
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peer.pc = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', to: peerId, candidate: e.candidate });
  };

  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'offer', to: peerId, sdp: pc.localDescription });
}

// ---------- viewer: answer an incoming offer ---------------------------------
async function receiveOffer(msg) {
  const peer = peers.get(msg.from) || { name: msg.from, sharing: true };
  peers.set(msg.from, peer);

  if (peer.pc) peer.pc.close();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peer.pc = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', to: msg.from, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    peer.stream = stream;
    const video = upsertTile(msg.from, peer.name || 'stream', true);
    if (video.srcObject !== stream) video.srcObject = stream;
    video.muted = false;
    video.play().catch(() => {});
  };

  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'answer', to: msg.from, sdp: pc.localDescription });
  await flushIce(peer);
}

async function flushIce(peer) {
  const queued = peer.pendingIce.splice(0);
  for (const c of queued) {
    try { await peer.pc.addIceCandidate(c); } catch {}
  }
}

// ---------- sharing control --------------------------------------------------
async function startSharing() {
  if (sharing) return;
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true, // system/tab audio where the browser permits
    });
  } catch (err) {
    logSys('screen capture cancelled');
    return;
  }

  sharing = true;
  setMe();
  renderRoster();

  // local self-preview
  const video = upsertTile('self', `${myName} (you)`, true);
  video.srcObject = localStream;
  video.muted = true; // never echo our own system audio back
  video.play().catch(() => {});

  send({ type: 'sharing', on: true });

  // offer to everyone already in the room
  for (const id of peers.keys()) await offerTo(id);

  // stop when the user hits the browser's native "Stop sharing"
  localStream.getVideoTracks()[0].addEventListener('ended', stopSharing);

  $('#shareBtn').textContent = 'Stop sharing';
  $('#shareBtn').classList.add('stop');
}

function stopSharing() {
  if (!sharing) return;
  sharing = false;

  if (localStream) {
    for (const t of localStream.getTracks()) t.stop();
    localStream = null;
  }
  for (const p of peers.values()) {
    if (p.pc) { p.pc.close(); p.pc = null; }
  }
  removeTile('self');
  send({ type: 'sharing', on: false });

  setMe();
  renderRoster();
  $('#shareBtn').textContent = 'Share screen';
  $('#shareBtn').classList.remove('stop');
  refreshEmpty();
}

// ---------- wiring -----------------------------------------------------------
$('#roomInput').value = room;

$('#joinBtn').addEventListener('click', () => {
  const next = ($('#roomInput').value || 'lobby').trim() || 'lobby';
  if (next === room) return;
  if (sharing) stopSharing();
  for (const [id, p] of peers) { if (p.pc) p.pc.close(); removeTile(id); }
  peers.clear();
  renderRoster();
  room = next;
  history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
  connect();
});

$('#shareBtn').addEventListener('click', () => {
  if (sharing) stopSharing();
  else startSharing();
});

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  logChat(myName, text, true);
  input.value = '';
});

window.addEventListener('beforeunload', () => { if (sharing) send({ type: 'sharing', on: false }); });

connect();
setMe();
renderRoster();
