'use strict';

/**
 * Pairing and live state for the /qbq presenter ⇄ /qbq/remote link.
 *
 * Deliberately in-process and deliberately ephemeral. A pairing session is a
 * live conversation between a laptop on a projector and a phone in someone's
 * hand: when the process restarts, that conversation is over and re-pairing is
 * the correct behavior, not a bug to engineer around. Only presentation EDITS
 * need durable storage, and those live in PostgreSQL
 * (database/qbqPresentation.js).
 *
 * No Express and no HTTP in here. Subscribers register a plain listener and the
 * route layer adapts that to Server-Sent Events, which keeps every rule below
 * testable without a socket.
 */

const crypto = require('node:crypto');

/** No 0/O/1/I/L — a code gets read aloud across a room and typed on a phone. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;                       // 31^6 ≈ 8.9e8 combinations
const CODE_TTL_MS = 5 * 60 * 1000;           // a code is for pairing, not for keeping
const SESSION_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 50;                     // bound the map; a talk needs one

const ACTIONS = new Set(['next', 'prev', 'zoomIn', 'zoomOut', 'reset']);

const ROLE_PRESENTER = 'presenter';
const ROLE_REMOTE = 'remote';

class QbqSessionError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'QbqSessionError';
    this.code = code;
    this.status = status;
  }
}

/** sessionId → session */
const sessions = new Map();
/** code → sessionId (only while the code is live and unconsumed) */
const codeIndex = new Map();
/** token → {sessionId, role} */
const tokenIndex = new Map();

const randomToken = () => crypto.randomBytes(32).toString('hex');
const randomId = () => crypto.randomBytes(12).toString('hex');

function randomCode() {
  // rejection-free: 31 does not divide 256, so take modulo over a wide draw and
  // accept the negligible bias, or redraw. Redrawing keeps it exactly uniform.
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of crypto.randomBytes(CODE_LENGTH * 2)) {
      if (byte >= 248) continue;             // 248 = 31 * 8 → uniform below it
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  // Presenters read codes aloud; accept lower case and stray spaces/dashes.
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '');
}

function emit(session, role, event) {
  for (const listener of session.listeners) {
    if (listener.role !== role) continue;
    try {
      listener.fn(event);
    } catch {
      // A broken stream must never take down a navigation command.
    }
  }
}

function dropCode(session) {
  if (session.code) codeIndex.delete(session.code);
  session.code = null;
  session.codeExpiresAt = 0;
}

function destroySession(session) {
  dropCode(session);
  tokenIndex.delete(session.presenterToken);
  if (session.remoteToken) tokenIndex.delete(session.remoteToken);
  emit(session, ROLE_REMOTE, { type: 'ended' });
  emit(session, ROLE_PRESENTER, { type: 'ended' });
  session.listeners.clear();
  sessions.delete(session.id);
}

/**
 * Expire stale sessions and codes.
 *
 * Called at the top of every public entry point rather than from a timer: a
 * setInterval would keep a handle alive in the server process and force tests
 * to juggle fake clocks for no benefit.
 */
function sweep(now = Date.now()) {
  for (const session of [...sessions.values()]) {
    if (now - session.lastActivityAt > SESSION_IDLE_TTL_MS) {
      destroySession(session);
      continue;
    }
    if (session.code && now > session.codeExpiresAt) dropCode(session);
  }
}

function touch(session, now = Date.now()) {
  session.lastActivityAt = now;
}

function publicState(session) {
  return {
    slide: session.state.slide,
    total: session.state.total,
    zoom: session.state.zoom,
    remoteConnected: Boolean(session.remoteToken),
  };
}

/** A presenter page opens a session and gets a code to read out. */
function createSession(now = Date.now()) {
  sweep(now);
  if (sessions.size >= MAX_SESSIONS) {
    // Evict the least recently active rather than refusing the presenter who
    // is standing in front of a room right now.
    const oldest = [...sessions.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
    if (oldest) destroySession(oldest);
  }
  const session = {
    id: randomId(),
    presenterToken: randomToken(),
    remoteToken: null,
    code: null,
    codeExpiresAt: 0,
    state: { slide: 0, total: 0, zoom: 1 },
    lastSeq: 0,
    nextCommandId: 1,
    listeners: new Set(),
    createdAt: now,
    lastActivityAt: now,
  };
  sessions.set(session.id, session);
  tokenIndex.set(session.presenterToken, { sessionId: session.id, role: ROLE_PRESENTER });
  const { code, codeExpiresAt } = issueCode(session.presenterToken, now);
  return {
    sessionId: session.id,
    presenterToken: session.presenterToken,
    code,
    codeExpiresAt,
  };
}

/** Regenerate the pairing code (presenter pressed "new code"). */
function issueCode(presenterToken, now = Date.now()) {
  const session = requireSession(presenterToken, ROLE_PRESENTER, now);
  dropCode(session);
  let code = randomCode();
  while (codeIndex.has(code)) code = randomCode();
  session.code = code;
  session.codeExpiresAt = now + CODE_TTL_MS;
  codeIndex.set(code, session.id);
  touch(session, now);
  return { code, codeExpiresAt: session.codeExpiresAt };
}

/**
 * Exchange a pairing code for a remote token.
 *
 * Three things keep this safe, and none of them is per-code lockout:
 *
 *   1. ENTROPY — 31^6 ≈ 8.9e8, and a guess must land on a code that is live
 *      right now, not on any code ever issued.
 *   2. A FIVE MINUTE TTL, so the target moves.
 *   3. PER-IP RATE LIMITING in the route layer (10 attempts / 5 min).
 *
 * A per-code "burn after N wrong guesses" counter deliberately does NOT exist:
 * a wrong guess does not resolve to a session at all (the lookup is code →
 * session), so such a counter could never be reached, and a version that
 * guessed at which session to penalize would let one attacker knock out a
 * presenter's code from across the internet.
 *
 * The code is CONSUMED on success, so it cannot be replayed onto a second phone.
 */
function pair(rawCode, now = Date.now()) {
  sweep(now);
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) {
    throw new QbqSessionError('Pairing code is not valid', 'INVALID_CODE', 400);
  }
  const sessionId = codeIndex.get(code);
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session || !session.code || now > session.codeExpiresAt) {
    throw new QbqSessionError('Pairing code is not valid', 'INVALID_CODE', 400);
  }

  // One remote at a time. Re-pairing invalidates the previous phone outright,
  // so a device that has been handed off cannot keep driving the deck.
  if (session.remoteToken) {
    tokenIndex.delete(session.remoteToken);
    emit(session, ROLE_REMOTE, { type: 'replaced' });
  }
  session.remoteToken = randomToken();
  session.lastSeq = 0;
  tokenIndex.set(session.remoteToken, { sessionId: session.id, role: ROLE_REMOTE });
  dropCode(session);
  touch(session, now);
  emit(session, ROLE_PRESENTER, { type: 'remote', connected: true });
  return {
    sessionId: session.id,
    remoteToken: session.remoteToken,
    state: publicState(session),
  };
}

/** Resolve a token to its session and role, or null. */
function authenticate(token, now = Date.now()) {
  sweep(now);
  if (typeof token !== 'string' || !token) return null;
  const entry = tokenIndex.get(token);
  if (!entry) return null;
  const session = sessions.get(entry.sessionId);
  if (!session) {
    tokenIndex.delete(token);
    return null;
  }
  return { session, role: entry.role };
}

function requireSession(token, role, now = Date.now()) {
  const found = authenticate(token, now);
  if (!found) throw new QbqSessionError('Session is not active', 'SESSION_NOT_FOUND', 401);
  if (role && found.role !== role) {
    throw new QbqSessionError('Wrong token for this action', 'WRONG_ROLE', 403);
  }
  return found.session;
}

/**
 * The presenter reports where the deck actually is.
 *
 * The presenter page is the single source of truth for slide and zoom: it owns
 * the component, so it reports the result of navigation rather than the server
 * predicting it. That is what keeps a remote correct after keyboard arrows, a
 * rail click, or a zoom clamp at the 60%/160% limits.
 */
function updateState(presenterToken, patch, now = Date.now()) {
  const session = requireSession(presenterToken, ROLE_PRESENTER, now);
  const next = { ...session.state };
  if (Number.isFinite(patch?.slide)) next.slide = Math.max(0, Math.trunc(patch.slide));
  if (Number.isFinite(patch?.total)) next.total = Math.max(0, Math.trunc(patch.total));
  if (Number.isFinite(patch?.zoom)) next.zoom = Math.min(4, Math.max(0.1, Number(patch.zoom)));
  session.state = next;
  touch(session, now);
  emit(session, ROLE_REMOTE, { type: 'state', state: publicState(session) });
  return publicState(session);
}

/**
 * A remote taps a button.
 *
 * `seq` is a per-remote counter that only ever goes up. Anything at or below
 * the last accepted value is ignored and answered `applied:false`, so a retried
 * or double-delivered request can never advance two slides. The forwarded
 * command carries its own id, which the presenter de-duplicates as well — one
 * tap moves exactly one slide no matter how fast the taps come.
 */
function submitCommand(remoteToken, { action, seq } = {}, now = Date.now()) {
  const session = requireSession(remoteToken, ROLE_REMOTE, now);
  if (!ACTIONS.has(action)) {
    throw new QbqSessionError('Unknown action', 'INVALID_ACTION', 400);
  }
  const n = Number(seq);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new QbqSessionError('seq must be a positive integer', 'INVALID_SEQ', 400);
  }
  touch(session, now);
  if (n <= session.lastSeq) {
    return { applied: false, reason: 'DUPLICATE', state: publicState(session) };
  }
  session.lastSeq = n;
  const command = { id: session.nextCommandId++, action };
  emit(session, ROLE_PRESENTER, { type: 'command', ...command });
  return { applied: true, command, state: publicState(session) };
}

/**
 * Subscribe to a session's events for the role the token carries.
 *
 * @returns {{unsubscribe: Function, session: object, role: string, state: object}}
 */
function subscribe(token, fn, now = Date.now()) {
  const found = authenticate(token, now);
  if (!found) throw new QbqSessionError('Session is not active', 'SESSION_NOT_FOUND', 401);
  const { session, role } = found;
  const listener = { role, fn };
  session.listeners.add(listener);
  touch(session, now);
  return {
    session,
    role,
    state: publicState(session),
    unsubscribe() {
      session.listeners.delete(listener);
    },
  };
}

/**
 * End a remote session.
 *
 * A remote token drops only the phone; the presenter keeps presenting. A
 * presenter token ends the whole session, which is the "End remote session"
 * action on the deck.
 */
function disconnect(token, now = Date.now()) {
  const found = authenticate(token, now);
  if (!found) return { ok: false };
  const { session, role } = found;
  if (role === ROLE_REMOTE) {
    tokenIndex.delete(session.remoteToken);
    session.remoteToken = null;
    session.lastSeq = 0;
    emit(session, ROLE_REMOTE, { type: 'ended' });
    for (const listener of [...session.listeners]) {
      if (listener.role === ROLE_REMOTE) session.listeners.delete(listener);
    }
    emit(session, ROLE_PRESENTER, { type: 'remote', connected: false });
    touch(session, now);
    return { ok: true, scope: ROLE_REMOTE };
  }
  destroySession(session);
  return { ok: true, scope: ROLE_PRESENTER };
}

/** Read-only snapshot, used by the pair response and by tests. */
function getState(sessionId) {
  const session = sessions.get(sessionId);
  return session ? publicState(session) : null;
}

/** Test hook — the module is process-global state by design. */
function __resetForTests() {
  sessions.clear();
  codeIndex.clear();
  tokenIndex.clear();
}

module.exports = {
  ACTIONS,
  CODE_LENGTH,
  CODE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  MAX_SESSIONS,
  ROLE_PRESENTER,
  ROLE_REMOTE,
  QbqSessionError,
  createSession,
  issueCode,
  pair,
  authenticate,
  updateState,
  submitCommand,
  subscribe,
  disconnect,
  getState,
  sweep,
  __resetForTests,
};
