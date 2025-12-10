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

app.get('/api/status', (req, res) => {
  res.json({ message: 'Server is running' });
});

io.on('connection', (socket) => {
  socket.emit('me', socket.id);

  // Join room with username
  socket.on('join-room', (roomId, userName) => {
    socket.join(roomId);
    // Broadcast to others: "User X connected with ID Y"
    socket.to(roomId).emit('user-connected', { userId: socket.id, userName });
  });

  // Relay signal. Include username so the receiver knows who is signaling.
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
