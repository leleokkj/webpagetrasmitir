// language: JavaScript (Node.js >=18), file: server.js
// Role: static host + WebSocket signaling relay. Never touches media — WebRTC is peer-to-peer.
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// roomId -> Map<clientId, ws>   (ws carries .id .name .sharing)
const rooms = new Map();

let seq = 0;
const nextId = () => 'c' + (++seq).toString(36) + Math.random().toString(36).slice(2, 7);

const peersOf = (room) => rooms.get(room) || new Map();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  for (const [id, c] of peersOf(room)) {
    if (id === exceptId) continue;
    send(c, obj);
  }
}

wss.on('connection', (ws) => {
  ws.id = nextId();
  ws.room = null;
  ws.name = 'anon';
  ws.sharing = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // ---- join a room ----------------------------------------------------
      case 'join': {
        const room = String(msg.room || 'lobby').slice(0, 64);
        ws.room = room;
        ws.name = String(msg.name || 'anon').slice(0, 32);

        if (!rooms.has(room)) rooms.set(room, new Map());
        const peers = rooms.get(room);

        // Tell the joiner who is already present (so it can render the roster).
        const existing = [...peers.entries()].map(([id, c]) => ({
          id, name: c.name, sharing: c.sharing,
        }));

        peers.set(ws.id, ws);
        send(ws, { type: 'joined', id: ws.id, room, peers: existing });
        // Tell everyone else so an active broadcaster can offer to the newcomer.
        broadcast(room, { type: 'peer-join', id: ws.id, name: ws.name }, ws.id);
        break;
      }

      // ---- SDP / ICE relay (server is a dumb switch) ----------------------
      case 'offer':
      case 'answer':
      case 'ice': {
        const target = peersOf(ws.room).get(msg.to);
        if (target) send(target, { ...msg, from: ws.id });
        break;
      }

      // ---- share state ----------------------------------------------------
      case 'sharing': {
        if (!ws.room) break;
        ws.sharing = !!msg.on;
        broadcast(ws.room, { type: 'sharing', id: ws.id, on: ws.sharing }, ws.id);
        break;
      }

      // ---- text chat ------------------------------------------------------
      case 'chat': {
        if (!ws.room) break;
        const text = String(msg.text || '').slice(0, 2000);
        if (!text) break;
        broadcast(ws.room, { type: 'chat', id: ws.id, name: ws.name, text, ts: Date.now() });
        break;
      }

      default: break;
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const peers = peersOf(ws.room);
    if (!peers.has(ws.id)) return;
    peers.delete(ws.id);
    broadcast(ws.room, { type: 'peer-leave', id: ws.id });
    if (ws.sharing) broadcast(ws.room, { type: 'sharing', id: ws.id, on: false });
    if (peers.size === 0) rooms.delete(ws.room);
  });
});

server.listen(PORT, () => {
  console.log(`ScreenCast signaling on http://localhost:${PORT}`);
});
