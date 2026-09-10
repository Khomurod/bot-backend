/**
 * The audit trail for what Wenze did to a provider's model chain, and when.
 *
 * Append-only. A model that vanished from a listing and was quietly dropped from
 * the chain is a routing change nobody asked for — the maintenance job may make
 * it, but it must leave a record a person can read, and a Telegram line can be
 * built from. Every row says which model, what happened, who initiated it and
 * enough detail to reconstruct the decision.
 */
const { query } = require('./pool');

const EVENTS = ['added', 'retired', 'replaced', 'restored', 'refused', 'selected'];
const INITIATORS = ['connect', 'refresh', 'manual', 'router'];

function mapEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    providerKey: row.provider_key,
    model: row.model,
    event: row.event,
    initiator: row.initiator,
    detail: row.detail || {},
    notifiedAt: row.notified_at ?? null,
    createdAt: row.created_at,
  };
}

async function recordModelEvent({ providerKey, model = null, event, initiator = 'refresh', detail = {} }) {
  if (!EVENTS.includes(event)) throw new Error(`Unknown model event "${event}"`);
  if (!INITIATORS.includes(initiator)) throw new Error(`Unknown initiator "${initiator}"`);
  const res = await query(
    `INSERT INTO ai_model_events (provider_key, model, event, initiator, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [providerKey, model, event, initiator, JSON.stringify(detail || {})]
  );
  return mapEvent(res.rows[0]);
}

async function listModelEvents({ providerKey = null, limit = 50 } = {}) {
  const res = providerKey
    ? await query(
      `SELECT * FROM ai_model_events WHERE provider_key = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [providerKey, limit]
    )
    : await query('SELECT * FROM ai_model_events ORDER BY created_at DESC, id DESC LIMIT $1', [limit]);
  return res.rows.map(mapEvent);
}

/** Retirements nobody has been told about yet — the maintenance job's work list. */
async function listUnnotifiedRetirements(providerKey) {
  const res = await query(
    `SELECT * FROM ai_model_events
      WHERE provider_key = $1 AND event = 'retired' AND notified_at IS NULL
      ORDER BY created_at ASC, id ASC`,
    [providerKey]
  );
  return res.rows.map(mapEvent);
}

/** Stamped only after the finding and the alert are written, so a failure retries. */
async function markEventsNotified(ids) {
  const clean = (ids || []).map(Number).filter(Number.isInteger);
  if (!clean.length) return 0;
  const res = await query(
    'UPDATE ai_model_events SET notified_at = NOW() WHERE id = ANY($1::bigint[]) AND notified_at IS NULL',
    [clean]
  );
  return res.rowCount || 0;
}

module.exports = {
  EVENTS, INITIATORS, recordModelEvent, listModelEvents, listUnnotifiedRetirements, markEventsNotified, mapEvent,
};
