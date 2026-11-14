'use strict';

/**
 * The owner's map from a CDL item to a Bitrix field (migration 0108;
 * docs/architecture/hiring-cdl-reading.md): `date_of_birth → contact
 * BIRTHDATE`, `license_number → deal UF_CRM_…`. An item with no row is
 * unmapped, and its value goes into the deal's timeline comment.
 *
 * Saved as a WHOLE in one transaction — the card in Settings sends every
 * item at once, so a save is never half-applied. The rows are checked before
 * they get here (lib/hiringStages/cdlWrite.js `normaliseMapping`); the table's
 * own CHECKs and its one-item-per-field index refuse what slips through.
 */

const { pool, query } = require('../pool');

const UNDEFINED_TABLE = '42P01';

function mapRow(row) {
  return {
    item: row.cdl_item,
    entity: row.entity,
    fieldCode: row.field_code,
    fieldLabel: row.field_label || null,
    fieldType: row.field_type || null,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at,
  };
}

/** The mapping; empty before migration 0108 (nothing mapped: everything goes to the comment). */
async function getFieldMap() {
  try {
    const { rows } = await query('SELECT * FROM hiring_cdl_field_map ORDER BY cdl_item');
    return rows.map(mapRow);
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

/**
 * Replace the mapping with `mapping` (already normalised).
 * @returns {Promise<object[]>} the mapping as stored
 */
async function saveFieldMap(mapping, { updatedBy = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM hiring_cdl_field_map');
    for (const m of mapping) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO hiring_cdl_field_map (cdl_item, entity, field_code, field_label, field_type, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [m.item, m.entity, m.fieldCode, m.fieldLabel || null, m.fieldType || null, updatedBy],
      );
    }
    const { rows } = await client.query('SELECT * FROM hiring_cdl_field_map ORDER BY cdl_item');
    await client.query('COMMIT');
    return rows.map(mapRow);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getFieldMap, saveFieldMap };
