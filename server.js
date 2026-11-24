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
app.use('/receiver', express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket Signaling State
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

function cleanupSocket(ws) {
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
  // Also check any connectionPair entries where ws was the responder
  for (const [connectionId, pair] of connectionPair.entries()) {
    if (pair[0] === ws || pair[1] === ws) {
      const otherWs = pair[0] === ws ? pair[1] : pair[0];
      safeSend(otherWs, { type: 'disconnect', connectionId });
      connectionPair.delete(connectionId);
    }
  }
  clients.delete(ws);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  clients.set(ws, new Set());

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    cleanupSocket(ws);
  });

  ws.on('error', () => {
    cleanupSocket(ws);
  });

  ws.on('message', (raw) => {
    ws.isAlive = true;
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
        const connectionId = data.connectionId || msg.from;
        const newOffer = {
          sdp: data.sdp,
          datetime: Date.now(),
          polite: false
        };

        // If this connectionId already has a paired peer (e.g. Unity sending renegotiation video offer),
        // route directly to the paired peer while keeping the pair intact
        if (connectionPair.has(connectionId)) {
          const pair = connectionPair.get(connectionId);
          const otherWs = pair[0] === ws ? pair[1] : (pair[1] === ws ? pair[0] : null);
          if (otherWs && otherWs.readyState === WebSocket.OPEN) {
            connectionPair.set(connectionId, [ws, otherWs]);
            safeSend(otherWs, { from: connectionId, to: '', type: 'offer', data: newOffer });
            break;
          }
        }

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
        const connectionId = data.connectionId || msg.from;
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
        const connectionId = data.connectionId || msg.from;
        const candidate = {
          candidate: data.candidate,
          sdpMLineIndex: data.sdpMLineIndex,
          sdpMid: data.sdpMid,
          datetime: Date.now()
        };

        if (connectionPair.has(connectionId)) {
          const pair = connectionPair.get(connectionId);
          const otherWs = pair[0] === ws ? pair[1] : (pair[1] === ws ? pair[0] : null);
          if (otherWs && otherWs.readyState === WebSocket.OPEN) {
            safeSend(otherWs, { from: connectionId, to: '', type: 'candidate', data: candidate });
            break;
          }
        }

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

// Heartbeat interval to evict dead/ghost connections immediately
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      cleanupSocket(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {}
  });
}, 15000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, () => {
  console.log(`Football AR Hosted WebApp & WebSocket Signaling Server listening on port ${PORT}`);
});
