let ioInstance = null;

function setIO(io) {
  ioInstance = io;
}

function orgRoom(organizationId) {
  return `org:${organizationId}`;
}

/** Broadcast an event to every socket that joined the given organization's room. */
function emitToOrg(organizationId, event, payload) {
  if (!ioInstance || !organizationId) return;
  ioInstance.to(orgRoom(organizationId)).emit(event, payload);
}

/** Send an event only to sockets belonging to one specific user (server.js joins socket.join(userId) on connect). */
function emitToUser(userId, event, payload) {
  if (!ioInstance || !userId) return;
  ioInstance.to(userId).emit(event, payload);
}

module.exports = { setIO, emitToOrg, emitToUser, orgRoom };
