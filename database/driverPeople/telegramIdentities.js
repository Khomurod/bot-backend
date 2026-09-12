/**
 * Which Telegram account belongs to which person, over time.
 *
 * `driver_profiles.telegram_user_id` answers "which account do we text for this
 * CHAT" and is lost when the chat is recreated. This answers "which account is
 * this HUMAN", with a start and an end, so the answer survives a chat change —
 * the same reason the person layer exists at all.
 *
 * ONE OPEN ROW PER ACCOUNT is a partial unique index in migration 0049, not a
 * check in here. A person may hold two accounts (a second phone); an account
 * may not be two people at once.
 */
const { query } = require('./../pool');

function mapIdentity(row) {
  if (!row) return null;
  return {
    id: row.id,
    personId: Number(row.person_id),
    telegramUserId: String(row.telegram_user_id),
    usernameAtLink: row.username_at_link || null,
    linkSource: row.link_source,
    confidence: row.confidence == null ? null : Number(row.confidence),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endedReason: row.ended_reason || null,
    evidence: row.evidence || null,
  };
}

/**
 * Open a link.
 *
 * @returns {Promise<object|null>} null when the account is already held by
 *   somebody — the unique index refusing, which is the guarantee working and
 *   not an error. A caller that treats null as a failure will retry for ever.
 */
async function openTelegramIdentity({
  personId, telegramUserId, usernameAtLink = null, linkSource = 'member_resolution',
  confidence = null, evidence = null,
}, client = null) {
  const run = client ? (t, v) => client.query(t, v) : query;
  const res = await run(
    `INSERT INTO driver_person_telegram_identities
       (person_id, telegram_user_id, username_at_link, link_source, confidence, evidence)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      Number(personId), String(telegramUserId), usernameAtLink, linkSource,
      confidence == null ? null : Number(confidence),
      evidence ? JSON.stringify(evidence) : null,
    ]
  );
  return mapIdentity(res.rows[0]);
}

/**
 * Close a link — the row is stamped, never deleted.
 *
 * "This account belonged to this person until March" is the honest record, and
 * it is what lets an account move to a new owner without losing where it was.
 */
async function closeTelegramIdentity({ telegramUserId, personId = null, reason = null }, client = null) {
  const run = client ? (t, v) => client.query(t, v) : query;
  const res = await run(
    `UPDATE driver_person_telegram_identities
        SET ended_at = NOW(), ended_reason = $3
      WHERE telegram_user_id = $1 AND ended_at IS NULL
        AND ($2::int IS NULL OR person_id = $2)
      RETURNING *`,
    [String(telegramUserId), personId == null ? null : Number(personId), reason]
  );
  return mapIdentity(res.rows[0]);
}

/** Who is behind this account right now, or null. */
async function findPersonByTelegramIdentity(telegramUserId, client = null) {
  if (telegramUserId == null) return null;
  const run = client ? (t, v) => client.query(t, v) : query;
  try {
    const res = await run(
      `SELECT * FROM driver_person_telegram_identities
        WHERE telegram_user_id = $1 AND ended_at IS NULL LIMIT 1`,
      [String(telegramUserId)]
    );
    return mapIdentity(res.rows[0]);
  } catch (_) {
    // A deploy that has not applied 0049 yet: the caller falls back to the
    // profile column, which is where this answer used to live.
    return null;
  }
}

/** Every account this person has held, current first. */
async function listTelegramIdentitiesForPerson(personId) {
  try {
    const res = await query(
      `SELECT * FROM driver_person_telegram_identities
        WHERE person_id = $1
        ORDER BY ended_at IS NULL DESC, started_at DESC, id DESC`,
      [Number(personId)]
    );
    return res.rows.map(mapIdentity);
  } catch (_) {
    return [];
  }
}

/** Accounts with an open link, for the resolver's "already taken" filter. */
async function listLinkedTelegramUserIds() {
  try {
    const res = await query(
      'SELECT telegram_user_id FROM driver_person_telegram_identities WHERE ended_at IS NULL'
    );
    return new Set(res.rows.map((r) => String(r.telegram_user_id)));
  } catch (_) {
    return new Set();
  }
}

/** Counts for /api/health and the Identity tab. */
async function summariseTelegramIdentities() {
  try {
    const res = await query(
      `SELECT COUNT(*) FILTER (WHERE ended_at IS NULL)::int AS linked,
              COUNT(DISTINCT person_id) FILTER (WHERE ended_at IS NULL)::int AS people,
              COUNT(*) FILTER (WHERE ended_at IS NOT NULL)::int AS closed
         FROM driver_person_telegram_identities`
    );
    const r = res.rows[0] || {};
    return { available: true, linked: r.linked || 0, people: r.people || 0, closed: r.closed || 0 };
  } catch (_) {
    return { available: false, linked: 0, people: 0, closed: 0 };
  }
}

module.exports = {
  openTelegramIdentity,
  closeTelegramIdentity,
  findPersonByTelegramIdentity,
  listTelegramIdentitiesForPerson,
  listLinkedTelegramUserIds,
  summariseTelegramIdentities,
};
