function isRoomOwner(room, socket) {
  return !!room && room.ownerUid === socket.data.uid && (!room.ownerClientId || room.ownerClientId === socket.data.clientId);
}

module.exports = { isRoomOwner };
