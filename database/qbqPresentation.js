'use strict';

/**
 * Data access for the hosted SOS/QBQ presentation (/qbq).
 *
 * Scope is deliberately tiny: the deck itself is an immutable file on disk and
 * only per-element TEXT OVERRIDES live here. Nothing in this module ever
 * stores, parses, or returns HTML — `content` is plain text, guaranteed by
 * services/qbq/sanitizeEditableText.js on the way in.
 *
 * This is isolated from the SOS questionnaire tables on purpose: presentation
 * edits and assessment submissions share no table and no query.
 *
 * See database/migrations/0005_qbq_presentation_edits.sql.
 */

const { query } = require('./pool');

/** The only deck hosted today. Also the table's column default. */
const DEFAULT_DECK_KEY = 'sos-offline-v2';

/**
 * Every stored override for one deck, oldest slide first.
 *
 * Callers render pages with this, so it must never throw for an empty deck —
 * an unedited presentation legitimately has zero rows.
 *
 * @returns {Promise<Array<{elementPath:string, slideIndex:number, content:string, updatedAt:Date}>>}
 */
async function listOverrides(deckKey = DEFAULT_DECK_KEY) {
  const res = await query(
    `SELECT element_path, slide_index, content, updated_at
       FROM qbq_presentation_edits
      WHERE deck_key = $1
      ORDER BY slide_index ASC, element_path ASC`,
    [deckKey],
  );
  return res.rows.map((row) => ({
    elementPath: row.element_path,
    slideIndex: row.slide_index,
    content: row.content,
    updatedAt: row.updated_at,
  }));
}

/** One override, or null. Used by tests and by the save endpoint's response. */
async function getOverride(elementPath, deckKey = DEFAULT_DECK_KEY) {
  const res = await query(
    `SELECT element_path, slide_index, content, updated_at
       FROM qbq_presentation_edits
      WHERE deck_key = $1 AND element_path = $2`,
    [deckKey, elementPath],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    elementPath: row.element_path,
    slideIndex: row.slide_index,
    content: row.content,
    updatedAt: row.updated_at,
  };
}

/**
 * Save one element's text.
 *
 * A SINGLE atomic UPSERT against the (deck_key, element_path) unique index —
 * never delete-then-insert. That is what makes a failed save harmless: if the
 * statement raises, the previously saved row is still exactly as it was, and
 * the caller reports the error without any recovery step.
 *
 * `content` must already be sanitized plain text; this layer does not sanitize,
 * so that there is one obvious owner of that rule rather than two.
 */
async function upsertOverride({
  elementPath,
  slideIndex,
  content,
  adminId = null,
  deckKey = DEFAULT_DECK_KEY,
}) {
  const res = await query(
    `INSERT INTO qbq_presentation_edits
       (deck_key, element_path, slide_index, content, updated_by_admin_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (deck_key, element_path) DO UPDATE
       SET content             = EXCLUDED.content,
           slide_index         = EXCLUDED.slide_index,
           updated_by_admin_id = EXCLUDED.updated_by_admin_id,
           updated_at          = NOW()
     RETURNING element_path, slide_index, content, updated_at`,
    [deckKey, elementPath, slideIndex, content, adminId],
  );
  const row = res.rows[0];
  return {
    elementPath: row.element_path,
    slideIndex: row.slide_index,
    content: row.content,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  DEFAULT_DECK_KEY,
  listOverrides,
  getOverride,
  upsertOverride,
};
