'use strict';

/**
 * A code-level ask, recorded for a person to act on.
 *
 * THE ONE RULE THIS MODULE ENFORCES, and it is enforced by having no way to
 * break it: nothing here reads, writes, fetches or executes anything a request
 * mentions. `linked_reference` is a sentence somebody typed — "PR #231" — and
 * this file treats it as forty characters of text, because the runtime bot
 * never touches source code and the cheapest way to keep that true is to give
 * the code no path to.
 *
 * THE CLAIM IS ON THE REPLY, not on the text. Telegram redelivers and the bot
 * restarts several times a day; two rows saying the same sentence is how a list
 * becomes noise. `uniq_engineering_request_reply` refuses the second, and
 * `fileRequest` returns the EXISTING row rather than null so the caller can
 * still tell the owner its number — a redelivery should read as "that is
 * request 12", not as a failure.
 */
const { query } = require('./pool');

const MAX_TEXT = 2000;
const OPEN = 'open';

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    source: row.source,
    replyId: row.reply_id == null ? null : Number(row.reply_id),
    findingId: row.finding_id == null ? null : Number(row.finding_id),
    requestedBy: row.requested_by || null,
    requestText: row.request_text,
    summary: row.summary || null,
    status: row.status,
    linkedReference: row.linked_reference || null,
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    decisionNote: row.decision_note || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Record an ask.
 *
 * @returns {Promise<{request: object, created: boolean}>} `created: false` when
 *   this reply already filed one — the row is still returned, because the
 *   caller has to name a number either way.
 */
async function fileRequest({
  source = 'control_reply', replyId = null, findingId = null,
  requestedBy = null, requestText,
}) {
  const text = String(requestText || '').trim().slice(0, MAX_TEXT);
  if (!text) {
    const err = new Error('An engineering request needs something to say.');
    err.code = 'EMPTY_REQUEST';
    throw err;
  }
  const res = await query(
    `INSERT INTO engineering_requests
       (source, reply_id, finding_id, requested_by, request_text)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (reply_id) WHERE reply_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      String(source),
      replyId == null ? null : Number(replyId),
      findingId == null ? null : Number(findingId),
      requestedBy == null ? null : String(requestedBy),
      text,
    ]
  );
  if (res.rows[0]) return { request: mapRow(res.rows[0]), created: true };

  // The claim lost. Hand back what is already there.
  const existing = await query(
    'SELECT * FROM engineering_requests WHERE reply_id = $1 LIMIT 1',
    [replyId == null ? null : Number(replyId)]
  );
  return { request: mapRow(existing.rows[0]), created: false };
}

/**
 * A person's decision on a request.
 *
 * `status` is the only field that changes what the application does — it is
 * what closes the companion finding. Everything else here is somebody writing
 * down what they know.
 */
async function decideRequest(id, {
  status, summary = null, linkedReference = null, decisionNote = null, decidedBy = null,
}) {
  const res = await query(
    `UPDATE engineering_requests
        SET status = COALESCE($2, status),
            summary = COALESCE($3, summary),
            linked_reference = COALESCE($4, linked_reference),
            decision_note = COALESCE($5, decision_note),
            decided_by = CASE WHEN $2 IS NULL THEN decided_by ELSE $6 END,
            decided_at = CASE WHEN $2 IS NULL THEN decided_at ELSE NOW() END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      Number(id),
      status ? String(status) : null,
      summary == null ? null : String(summary).slice(0, MAX_TEXT),
      linkedReference == null ? null : String(linkedReference).slice(0, 200),
      decisionNote == null ? null : String(decisionNote).slice(0, MAX_TEXT),
      decidedBy == null ? null : String(decidedBy),
    ]
  );
  return mapRow(res.rows[0]);
}

/** Everything still waiting for somebody. The sweep's read. */
async function listOpenRequests({ limit = 50 } = {}) {
  try {
    const res = await query(
      `SELECT * FROM engineering_requests
        WHERE status = $1 ORDER BY created_at ASC LIMIT $2`,
      [OPEN, Math.max(1, Math.min(200, Number(limit) || 50))]
    );
    return res.rows.map(mapRow);
  } catch (_) {
    // Before migration 0051 has run, nothing is waiting. Degrading to an empty
    // list keeps the sweep filing every other finding.
    return [];
  }
}

/** The admin's list. */
async function listRequests({ status = null, limit = 100 } = {}) {
  try {
    const res = await query(
      `SELECT * FROM engineering_requests
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at DESC LIMIT $2`,
      [status, Math.max(1, Math.min(200, Number(limit) || 100))]
    );
    return res.rows.map(mapRow);
  } catch (_) {
    return [];
  }
}

async function getRequestById(id) {
  const res = await query('SELECT * FROM engineering_requests WHERE id = $1', [Number(id)]);
  return mapRow(res.rows[0]);
}

/** Counts only, for /api/health. No request text ever leaves this function. */
async function summariseRequests() {
  try {
    const res = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
              COUNT(*) FILTER (WHERE status IN ('accepted','in_progress'))::int AS taken,
              COUNT(*) FILTER (WHERE status = 'done')::int AS done,
              COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
              MAX(created_at) AS last_at
         FROM engineering_requests`
    );
    const r = res.rows[0] || {};
    return {
      available: true,
      open: r.open || 0,
      taken: r.taken || 0,
      done: r.done || 0,
      declined: r.declined || 0,
      lastAt: r.last_at || null,
    };
  } catch (_) {
    return { available: false, open: 0, taken: 0, done: 0, declined: 0, lastAt: null };
  }
}

module.exports = {
  MAX_TEXT,
  fileRequest,
  decideRequest,
  listOpenRequests,
  listRequests,
  getRequestById,
  summariseRequests,
};
