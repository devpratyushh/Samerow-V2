const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const port = 3000;

app.use(cors());
app.use(express.json());

// In-memory room state storage
// Structure: { [roomId]: { mediaState: { url, isPlaying, timestamp, lastUpdate, source } } }
const rooms = {};

app.get('/api/status', (req, res) => {
  res.json({ message: 'Server is running' });
});

// Jellyfin Webhook Endpoint
app.post('/api/webhook/jellyfin', (req, res) => {
  const payload = req.body;

  if (!payload || !payload.NotificationType) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Expecting the roomId to be passed as a query parameter from the user's Jellyfin config
  const roomId = req.query.roomId;
  if (!roomId || !rooms[roomId]) {
    return res.status(404).json({ error: 'Room not found' });
  }

  // Expecting a token to be passed as a query parameter for simple authentication
  // The token is generated and stored in the room state when the user creates/joins the room.
  const token = req.query.token;
  if (!token || rooms[roomId].webhookToken !== token) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing token' });
  }

  const { NotificationType, PlaybackPositionTicks } = payload;

  // Jellyfin uses ticks (10,000 ticks = 1 millisecond). Convert to seconds.
  const timestamp = PlaybackPositionTicks ? PlaybackPositionTicks / 10000000 : 0;

  let isPlaying = rooms[roomId].mediaState ? rooms[roomId].mediaState.isPlaying : false;

  if (NotificationType === 'PlaybackStart' || NotificationType === 'PlaybackUnpause') {
    isPlaying = true;
  } else if (NotificationType === 'PlaybackPause' || NotificationType === 'PlaybackStop') {
    isPlaying = false;
  }

  // Update room state
  if (!rooms[roomId].mediaState) {
    rooms[roomId].mediaState = { url: null, isPlaying: false, timestamp: 0, lastUpdate: Date.now(), source: 'jellyfin' };
  }

  rooms[roomId].mediaState = {
    ...rooms[roomId].mediaState,
    isPlaying,
    timestamp,
    lastUpdate: Date.now()
  };

  // Broadcast to room
  io.to(roomId).emit('media-state-change', { isPlaying, timestamp, source: 'jellyfin' });

  res.sendStatus(200);
});

io.on('connection', (socket) => {
  socket.emit('me', socket.id);

  // Join room with username
  socket.on('join-room', (roomId, userName) => {
    socket.join(roomId);

    // Initialize room state if not exists
    if (!rooms[roomId]) {
      // Generate a simple random token for webhook authentication
      const webhookToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      rooms[roomId] = {
        webhookToken: webhookToken,
        mediaState: {
          url: null,
          isPlaying: false,
          timestamp: 0,
          lastUpdate: Date.now(),
          source: 'youtube' // Default source or null
        }
      };
    }

    socket.to(roomId).emit('user-connected', { userId: socket.id, userName });
  });

  // Sync Request: New user asks for current state
  socket.on('sync-request', (roomId) => {
    if (rooms[roomId]) {
      // Send webhook token to the client so they can configure their Jellyfin
      socket.emit('webhook-token', rooms[roomId].webhookToken);

      if (rooms[roomId].mediaState) {
        // Calculate interpolated timestamp if playing logic is needed,
        // but for simplicity, we send the last known state and let client handle seek if needed.
        socket.emit('media-change', { url: rooms[roomId].mediaState.url, source: rooms[roomId].mediaState.source });
        socket.emit('media-state-change', rooms[roomId].mediaState);
      }
    }
  });

  // Media Events
  socket.on('media-change', ({ roomId, url, source }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        mediaState: {
          url: null, isPlaying: false, timestamp: 0, lastUpdate: Date.now(), source: source || 'youtube'
        }
      };
    }

    rooms[roomId].mediaState = {
      url,
      isPlaying: true, // Auto-play new video
      timestamp: 0,
      lastUpdate: Date.now(),
      source: source || 'youtube'
    };
    io.to(roomId).emit('media-change', { url, source: rooms[roomId].mediaState.source });
  });

  socket.on('media-state-change', ({ roomId, isPlaying, timestamp, source }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { mediaState: { url: null, isPlaying: false, timestamp: 0, lastUpdate: Date.now(), source: source || 'youtube' } };
    }
    rooms[roomId].mediaState = {
      ...rooms[roomId].mediaState,
      isPlaying,
      timestamp,
      lastUpdate: Date.now()
    };
    // Broadcast to everyone ELSE in the room (prevent loop back to sender if possible, 
    // but io.to(roomId) sends to everyone. using socket.to(roomId) excludes sender)
    // We want to exclude sender to avoid feedback loops!
    socket.to(roomId).emit('media-state-change', { isPlaying, timestamp, source: rooms[roomId].mediaState.source });
  });

  socket.on('update-user-state', ({ roomId, type, enabled }) => {
    socket.to(roomId).emit('user-state-updated', { userId: socket.id, type, enabled });
  });

  socket.on('signal', ({ signal, to, userName, isScreenShare }) => {
    io.to(to).emit('signal', { signal, from: socket.id, userName, isScreenShare });
  });

  socket.on('disconnect', () => {
    socket.broadcast.emit("user-disconnected", socket.id);
  });
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
