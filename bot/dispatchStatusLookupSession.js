const SESSION_TTL_MS = 10 * 60 * 1000;

const sessions = new Map();

function sessionKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

function isExpired(session) {
  if (!session) return true;
  return Date.now() > session.expiresAt;
}

function start(chatId, userId) {
  const key = sessionKey(chatId, userId);
  const session = {
    step: 'awaiting_name',
    candidates: [],
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(key, session);
  return session;
}

function get(chatId, userId) {
  const key = sessionKey(chatId, userId);
  const session = sessions.get(key);
  if (!session || isExpired(session)) {
    sessions.delete(key);
    return null;
  }
  return session;
}

function setCandidates(chatId, userId, candidates) {
  const session = get(chatId, userId);
  if (!session) return null;
  session.step = 'awaiting_pick';
  session.candidates = candidates;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function clear(chatId, userId) {
  sessions.delete(sessionKey(chatId, userId));
}

module.exports = {
  SESSION_TTL_MS,
  start,
  get,
  setCandidates,
  clear,
  isExpired,
};
