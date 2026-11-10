'use strict';

/**
 * Stage rows as Bitrix's `crm.status.list` really answers them — its REST
 * documentation's own example: `ID` is the row's number in the status table,
 * `STATUS_ID` is the stage code a deal or truck item carries.
 *
 * Board ↔ Bitrix tests once fed discovery rows with the stage code in `ID`. The
 * code read `ID` as the stage, the tests agreed with it, and production — where
 * `ID` is "703" — never matched a single truck stage (November 2026). Every
 * discovery test now answers `crm.status.list` through this, so a reader that
 * takes `ID` for the stage fails here first.
 *
 * Input rows are the shape the rest of the code reads (`{ ID|id: code, NAME|name }`).
 */
let next = 700;

function bitrixStatusRows(rows, entityId) {
  const categoryId = /_(\d+)$/.exec(String(entityId))?.[1] ?? null;
  return (rows || []).map((row, i) => {
    next += 2;
    const name = String(row.NAME ?? row.name ?? '');
    return {
      ID: String(next), // a row number that is never a stage
      ENTITY_ID: String(entityId),
      STATUS_ID: String(row.STATUS_ID ?? row.ID ?? row.id),
      NAME: name,
      NAME_INIT: name,
      SORT: String((i + 1) * 10),
      SYSTEM: 'N',
      CATEGORY_ID: categoryId,
      COLOR: '#39A8EF',
      SEMANTICS: null,
      EXTRA: { SEMANTICS: 'process', COLOR: '#39A8EF' },
    };
  });
}

module.exports = { bitrixStatusRows };
