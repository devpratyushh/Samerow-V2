const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");
const { isVideoUrl, isTimestamp, createState, snapshot, updateState } = require("./youtube");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory room state storage
// Structure: { [roomId]: { youtubeState: { url, isPlaying, timestamp, lastUpdate } } }
const rooms = Object.create(null);

const isValidRoomId = (roomId) => {
  return typeof roomId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(roomId);
};

app.get('/api/status', (req, res) => {
  res.json({ message: 'Server is running' });
});

io.on('connection', (socket) => {
  socket.emit('me', socket.id);

  // Join room with username
  socket.on('join-room', (roomId, userName) => {
    if (!isValidRoomId(roomId) || socket.rooms.has(roomId)) return;
    socket.join(roomId);

    // Initialize room state if not exists
    if (!rooms[roomId]) {
      rooms[roomId] = { youtubeState: createState() };
    }

    socket.to(roomId).emit('user-connected', { userId: socket.id, userName });
  });

  // Only participants may inspect or change a room's playback.
  socket.on('sync-request', (roomId) => {
    if (!isValidRoomId(roomId) || !socket.rooms.has(roomId) || !rooms[roomId]) return;
    socket.emit('youtube-sync', snapshot(rooms[roomId].youtubeState));
  });

  socket.on('youtube-change', (payload = {}) => {
    if (!payload) return;
    const { roomId, url, timestamp = 0 } = payload;
    if (!isValidRoomId(roomId) || !socket.rooms.has(roomId)) return;
    if (url !== null && !isVideoUrl(url)) return;
    if (!isTimestamp(timestamp)) return;
    rooms[roomId].youtubeState = createState(url, url ? timestamp : 0);
    io.to(roomId).emit('youtube-sync', snapshot(rooms[roomId].youtubeState));
  });

  socket.on('youtube-state-change', (payload = {}) => {
    if (!payload) return;
    const { roomId } = payload;
    if (!isValidRoomId(roomId) || !socket.rooms.has(roomId) || !rooms[roomId]) return;
    const next = updateState(rooms[roomId].youtubeState, payload);
    if (!next) return;
    rooms[roomId].youtubeState = next;
    io.to(roomId).emit('youtube-sync', snapshot(next));
  });

  socket.on('update-user-state', ({ roomId, type, enabled }) => {
    if (!isValidRoomId(roomId)) return;
    socket.to(roomId).emit('user-state-updated', { userId: socket.id, type, enabled });
  });

  socket.on('signal', ({ signal, to, userName, isScreenShare }) => {
    io.to(to).emit('signal', { signal, from: socket.id, userName, isScreenShare });
  });

  socket.on('disconnect', () => {
    socket.broadcast.emit("user-disconnected", socket.id);
  });
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = { server, io };
