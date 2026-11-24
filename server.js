const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 80;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Session-Id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Config endpoint used by Unity Render Streaming WebApp client
app.get('/config', (req, res) => {
  res.json({
    useWebSocket: true,
    startupMode: 'public',
    logging: 'dev'
  });
});

// Serve static HTML/CSS/JS/module files directly from this folder
app.use(express.static(__dirname));
// Also support /receiver route if accessed via /receiver
app.use('/receiver', express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket Signaling State (Public Broadcast Mode compatible with Unity Broadcast component)
const clients = new Map(); // Map<WebSocket, Set<string>>
const connectionPair = new Map(); // Map<string, [WebSocket, WebSocket]>

function getOrCreateConnectionIds(ws) {
  if (!clients.has(ws)) {
    clients.set(ws, new Set());
  }
  return clients.get(ws);
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

wss.on('connection', (ws) => {
  clients.set(ws, new Set());

  ws.on('close', () => {
    const connectionIds = clients.get(ws);
    if (connectionIds) {
      connectionIds.forEach((connectionId) => {
        const pair = connectionPair.get(connectionId);
        if (pair) {
          const otherWs = pair[0] === ws ? pair[1] : pair[0];
          safeSend(otherWs, { type: 'disconnect', connectionId });
        }
        connectionPair.delete(connectionId);
      });
    }
    clients.delete(ws);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (!msg) return;

    switch (msg.type) {
      case 'connect': {
        const connectionId = msg.connectionId;
        const connectionIds = getOrCreateConnectionIds(ws);
        connectionIds.add(connectionId);
        safeSend(ws, { type: 'connect', connectionId, polite: true });
        break;
      }
      case 'disconnect': {
        const connectionId = msg.connectionId;
        const connectionIds = clients.get(ws);
        if (connectionIds) connectionIds.delete(connectionId);

        if (connectionPair.has(connectionId)) {
          const pair = connectionPair.get(connectionId);
          const otherWs = pair[0] === ws ? pair[1] : pair[0];
          safeSend(otherWs, { type: 'disconnect', connectionId });
        }
        connectionPair.delete(connectionId);
        safeSend(ws, { type: 'disconnect', connectionId });
        break;
      }
      case 'offer': {
        const data = msg.data || {};
        const connectionId = data.connectionId;
        const newOffer = {
          sdp: data.sdp,
          datetime: Date.now(),
          polite: false
        };
        connectionPair.set(connectionId, [ws, null]);
        clients.forEach((_v, clientWs) => {
          if (clientWs !== ws) {
            safeSend(clientWs, { from: connectionId, to: '', type: 'offer', data: newOffer });
          }
        });
        break;
      }
      case 'answer': {
        const data = msg.data || {};
        const connectionId = data.connectionId;
        const connectionIds = getOrCreateConnectionIds(ws);
        connectionIds.add(connectionId);
        const newAnswer = {
          sdp: data.sdp,
          datetime: Date.now()
        };
        if (!connectionPair.has(connectionId)) return;
        const pair = connectionPair.get(connectionId);
        const otherWs = pair[0] === ws ? pair[1] : pair[0];
        connectionPair.set(connectionId, [otherWs, ws]);
        safeSend(otherWs, { from: connectionId, to: '', type: 'answer', data: newAnswer });
        break;
      }
      case 'candidate': {
        const data = msg.data || {};
        const connectionId = data.connectionId;
        const candidate = {
          candidate: data.candidate,
          sdpMLineIndex: data.sdpMLineIndex,
          sdpMid: data.sdpMid,
          datetime: Date.now()
        };
        clients.forEach((_v, clientWs) => {
          if (clientWs !== ws) {
            safeSend(clientWs, { from: connectionId, to: '', type: 'candidate', data: candidate });
          }
        });
        break;
      }
      default:
        break;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Football AR Hosted WebApp & WebSocket Signaling Server listening on port ${PORT}`);
});
