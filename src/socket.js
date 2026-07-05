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

module.exports = { setIO, emitToOrg, orgRoom };
