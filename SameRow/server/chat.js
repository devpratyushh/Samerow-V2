function installChat(io, { store, identity }) {
  io.on('connection', socket => {
    socket.handle('chat-history', async (payload = {}, ack) => {
      if (typeof ack !== 'function' || !payload || socket.data.roomId !== payload.roomId || !socket.rooms.has(payload.roomId)) return;
      const limit = 50;
      let messages;
      if (identity.firestore) {
        const collection = identity.firestore.collection('rooms').doc(payload.roomId).collection('messages');
        let query = collection.orderBy('createdAt', 'desc').limit(limit);
        if (payload.before) {
          if (typeof payload.before !== 'string' || !/^[A-Za-z0-9_-]{1,192}$/.test(payload.before)) return;
          const cursor = await collection.doc(payload.before).get();
          if (!cursor.exists) return ack({ error: 'That message is no longer available.' });
          query = query.startAfter(cursor);
        }
        const result = await query.get();
        messages = result.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toMillis?.() || 0 })).reverse();
      } else {
        const history = await store.get(`chat:${payload.roomId}`) || [];
        const end = payload.before ? history.findIndex(value => value.id === payload.before) : history.length;
        messages = history.slice(Math.max(0, end - limit), Math.max(0, end));
      }
      ack({ messages, hasMore: messages.length === limit });
    });
    socket.handle('chat-send', async (payload = {}, ack) => {
      if (!payload || socket.data.roomId !== payload.roomId || !socket.rooms.has(payload.roomId) || typeof ack !== 'function') return;
      if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000 || typeof payload.id !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.id)) return ack({ error: 'Enter a message of at most 4,000 characters.' });
      if (!await store.limit(`chat-send:${socket.data.uid}`, 30, 60)) return ack({ error: 'Please wait before sending more messages.' });
      const id = `${socket.data.uid.replace(/[^A-Za-z0-9_-]/g, '_')}_${payload.id}`;
      let message = { id, text: payload.text.trim(), sender: socket.data.userName, senderId: socket.data.uid, createdAt: Date.now() };
      if (identity.firestore) {
        const { Timestamp } = require('firebase-admin/firestore');
        const ref = identity.firestore.collection('rooms').doc(payload.roomId).collection('messages').doc(id);
        try { await ref.create({ ...message, createdAt: Timestamp.fromMillis(message.createdAt) }); }
        catch (error) {
          if (error.code !== 6) throw error;
          const previous = (await ref.get()).data(); message = { ...previous, createdAt: previous.createdAt.toMillis() };
        }
      } else {
        const history = await store.update(`chat:${payload.roomId}`, current => {
          const values = current || [];
          return values.some(value => value.id === id) ? values : [...values, message].slice(-1000);
        }, 604800);
        message = history.find(value => value.id === id);
      }
      io.to(payload.roomId).emit('chat-message', message); ack({ message });
    });
  });
}
module.exports = { installChat };
