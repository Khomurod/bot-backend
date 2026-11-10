'use strict';

/**
 * Bitrix stages, read the one way Bitrix means them. Pure.
 *
 * `crm.status.list` answers every stage with TWO identifiers that look alike:
 *
 *   ID         the row's own number in Bitrix's status table ("703")
 *   STATUS_ID  the stage itself — what a deal carries in STAGE_ID and a truck
 *              item in stageId ("C3:UC_XZ955I", "DT1040_17:UC_90RJVZ")
 *
 * Only STATUS_ID is a stage. Until November 2026 the Board ↔ Bitrix schema read
 * ID as the stage, so the catalogue ("703") and the truck counts
 * ("DT1040_17:UC_90RJVZ") never met: every truck stage looked empty, the
 * historical bootstrap could not find its stages, and the November 9 schema
 * saved driver stages as row numbers — which a live sync would have written
 * into deals as STAGE_ID. So every stage row is turned into ONE shape here, at
 * the moment it is read, and a row without STATUS_ID makes the read incomplete:
 * nothing downstream may ever see a row number where a stage belongs.
 *
 * The shapes Bitrix gives stage codes (its REST documentation):
 *   deal pipeline n > 0      `C{n}:{CODE}`
 *   smart process e, cat c   `DT{e}_{c}:{CODE}`
 */

const ROW_NUMBER = /^\d+$/;

/**
 * Stage rows as everything downstream reads them:
 * `{ id: STATUS_ID, name, sort, semantics, __categoryId? }`.
 *
 * @param {Array} raw  the `crm.status.list` result
 * @param {{categoryId?: number}} [options]  the Trucks category the rows were read for
 * @returns {{rows: Array, problem: string|null}}
 */
function normalizeStageRows(raw, { categoryId = null } = {}) {
  const rows = [];
  let broken = 0;
  for (const row of Array.isArray(raw) ? raw : []) {
    const code = String(row?.STATUS_ID ?? row?.statusId ?? '').trim();
    if (!code) { broken += 1; continue; }
    rows.push({
      id: code,
      name: String(row?.NAME ?? row?.name ?? '').trim(),
      sort: Number(row?.SORT ?? row?.sort) || 0,
      semantics: String(row?.EXTRA?.SEMANTICS ?? row?.SEMANTICS ?? row?.semantics ?? '').trim(),
      ...(categoryId == null ? {} : { __categoryId: Number(categoryId) }),
    });
  }
  return {
    rows,
    problem: broken
      ? `Bitrix returned ${broken} stage row(s) without STATUS_ID; the stage catalogue is incomplete`
      : null,
  };
}

/** `C3:` for deal pipeline 3; '' for the default pipeline, whose codes carry no prefix. */
function dealStagePrefix(categoryId) {
  return Number(categoryId) > 0 ? `C${Number(categoryId)}:` : '';
}

/** `DT1040_17:` for smart process 1040, category 17. */
function truckStagePrefix(entityTypeId, categoryId) {
  return `DT${Number(entityTypeId)}_${Number(categoryId)}:`;
}

/** Why `id` cannot be a stage of the pipeline `prefix` names; null when it can. */
function stageCodeProblem(id, prefix = '') {
  const code = String(id ?? '').trim();
  if (!code) return 'an empty stage id';
  if (ROW_NUMBER.test(code)) return `"${code}" is a Bitrix row number, not a stage`;
  if (prefix && !code.startsWith(prefix)) return `"${code}" is not a stage of the selected pipeline (${prefix}…)`;
  return null;
}

module.exports = {
  normalizeStageRows, dealStagePrefix, truckStagePrefix, stageCodeProblem,
};
