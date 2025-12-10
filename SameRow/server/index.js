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
// Structure: { [roomId]: { youtubeState: { url, isPlaying, timestamp, lastUpdate } } }
const rooms = {};

app.get('/api/status', (req, res) => {
  res.json({ message: 'Server is running' });
});

io.on('connection', (socket) => {
  socket.emit('me', socket.id);

  // Join room with username
  socket.on('join-room', (roomId, userName) => {
    socket.join(roomId);

    // Initialize room state if not exists
    if (!rooms[roomId]) {
      rooms[roomId] = {
        youtubeState: {
          url: null,
          isPlaying: false,
          timestamp: 0,
          lastUpdate: Date.now()
        }
      };
    }

    socket.to(roomId).emit('user-connected', { userId: socket.id, userName });
  });

  // Sync Request: New user asks for current state
  socket.on('sync-request', (roomId) => {
    if (rooms[roomId] && rooms[roomId].youtubeState) {
      // Calculate interpolated timestamp if playing logic is needed, 
      // but for simplicity, we send the last known state and let client handle seek if needed.
      socket.emit('youtube-change', rooms[roomId].youtubeState.url);
      socket.emit('youtube-state-change', rooms[roomId].youtubeState);
    }
  });

  // YouTube Events
  socket.on('youtube-change', ({ roomId, url }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        youtubeState: {
          url: null, isPlaying: false, timestamp: 0, lastUpdate: Date.now()
        }
      };
    }

    rooms[roomId].youtubeState = {
      url,
      isPlaying: true, // Auto-play new video
      timestamp: 0,
      lastUpdate: Date.now()
    };
    io.to(roomId).emit('youtube-change', url);
  });

  socket.on('youtube-state-change', ({ roomId, isPlaying, timestamp }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { youtubeState: { url: null, isPlaying: false, timestamp: 0, lastUpdate: Date.now() } };
    }
    rooms[roomId].youtubeState = {
      ...rooms[roomId].youtubeState,
      isPlaying,
      timestamp,
      lastUpdate: Date.now()
    };
    // Broadcast to everyone ELSE in the room (prevent loop back to sender if possible, 
    // but io.to(roomId) sends to everyone. using socket.to(roomId) excludes sender)
    // We want to exclude sender to avoid feedback loops!
    socket.to(roomId).emit('youtube-state-change', { isPlaying, timestamp });
  });

  socket.on('update-user-state', ({ roomId, type, enabled }) => {
    socket.to(roomId).emit('user-state-updated', { userId: socket.id, type, enabled });
  });

  socket.on('signal', ({ signal, to, userName }) => {
    io.to(to).emit('signal', { signal, from: socket.id, userName });
  });

  socket.on('disconnect', () => {
    socket.broadcast.emit("user-disconnected", socket.id);
  });
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
