'use strict';

/**
 * Reading the Dispatcher Board's answer, without trusting its shape.
 *
 * The Board is a Google Apps Script in front of a spreadsheet that people edit
 * every day. Its JSON is not a contract: a column can be renamed, a field can
 * arrive as a number where it was a string, and the row array can be published
 * under a different key by whoever last touched the script. A parser that threw
 * on any of that would take out the poller — and the poller is how Wenze learns
 * who is in which truck.
 *
 * So this reads TOLERANTLY and reports what it could not place:
 *
 *   - the row array is looked for under several plausible keys;
 *   - each field is read through a short list of aliases;
 *   - every key on a row that matched no alias is recorded by NAME in
 *     `problems` — names only, never values — so the first `Test` click in
 *     Settings tells us the real shape without putting fleet data on a screen
 *     or in a log;
 *   - anything unreadable becomes a problem entry, never an exception.
 *
 * WHAT IT DOES NOT DO. It does not interpret. `eta`, `origin_delivery` and
 * `notes` are free text a dispatcher types and are stored verbatim; the status
 * keeps its raw spelling beside the upper-cased token; and no field here is
 * ever allowed to decide anything. Meaning is added later, by code that can be
 * argued with — this file only says what the Board said.
 */
const { parseFleetLabel, FLEET_TYPES } = require('../drivers/fleetType');
const { normalizeBoardTruck, digitsOnlyTruck } = require('./truck');
const { boardRowKey } = require('./rowKey');

/** Where the rows might live. First non-empty array wins. */
const ROW_KEYS = ['rows', 'drivers', 'data', 'items', 'records'];

/** Per-field aliases, in preference order. Lower-cased for the lookup. */
const FIELD_ALIASES = Object.freeze({
  sheetRow: ['row', 'sheet_row', 'row_number', 'rownum'],
  driverName: ['driver_name', 'driver', 'name', 'drivers'],
  truck: ['truck', 'truck_number', 'unit', 'unit_number', 'truck_no'],
  boardTrailer: ['trailer', 'trailer_number', 'trailer_no'],
  phone: ['phone', 'phone_number', 'cell', 'mobile'],
  status: ['status', 'state', 'driver_status'],
  etaText: ['eta', 'eta_text', 'etatext'],
  originDelivery: ['origin_delivery', 'origin', 'route', 'from_to', 'origin_destination'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks'],
  dispatcher: ['dispatcher', 'dispatcher_name', 'dispatch'],
  lastUpdatedBy: ['last_updated_by', 'updated_by', 'editor'],
  isTeam: ['is_team', 'team', 'is_team_driver'],
});

/** Top-level fields that are not rows and are not unknown keys. */
const META_ALIASES = Object.freeze({
  boardDate: ['board_date', 'date', 'for_date'],
  generatedAt: ['generated_at', 'generated', 'timestamp', 'updated_at'],
  count: ['count', 'total', 'row_count'],
});

/** The statuses seen on the live Board. Anything else is reported, not guessed. */
const KNOWN_STATUSES = Object.freeze([
  'HOME', 'VACATION', 'DISPATCHED', 'ENROUTE', 'READY', 'RESERVED', 'REST', 'SHOP',
]);

/**
 * Case-insensitive lookup over one object, by a list of alias names.
 *
 * `matched` lists EVERY alias the object carries, not just the one that had a
 * value: a column present but empty is a column we recognise, and reporting it
 * as unknown would send somebody looking for a field that is already read.
 */
function pick(lowerMap, aliases) {
  const matched = [];
  let value = null;
  for (const alias of aliases) {
    if (!Object.prototype.hasOwnProperty.call(lowerMap, alias)) continue;
    matched.push(alias);
    const raw = lowerMap[alias];
    if (value === null && raw !== undefined && raw !== null && String(raw).trim() !== '') {
      value = raw;
    }
  }
  return { value, matched };
}

/** Every own key of an object, lower-cased, with its value. */
function lowerKeyed(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) out[String(key).toLowerCase()] = value;
  return out;
}

function text(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** `true`, `"true"`, `"yes"`, `1` — anything else is false, never a guess. */
function truthy(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

/**
 * Is this one row about two people?
 *
 * Two independent signals — the Board's own flag, and a ` / ` in the name — and
 * they are allowed to disagree. A disagreement is recorded rather than
 * resolved: the flag says the dispatcher meant a team, the separator says they
 * typed one, and which is right is a question for a person.
 */
function detectTeam(rawName, flagValue) {
  const name = String(rawName == null ? '' : rawName);
  const parts = name.split(/\s+\/\s+|\s+&\s+/).map((p) => p.trim()).filter(Boolean);
  const byName = parts.length > 1;
  const byFlag = truthy(flagValue);
  return {
    isTeam: byName || byFlag,
    members: byName ? parts : [],
    flagMismatch: byName !== byFlag,
  };
}

/** Upper-cased token plus the raw spelling, and whether we have seen it before. */
function parseStatus(value) {
  const raw = text(value);
  if (!raw) return { status: 'UNKNOWN', raw: null, known: false };
  const token = raw.toUpperCase().replace(/\s+/g, ' ');
  return { status: token, raw, known: KNOWN_STATUSES.includes(token) };
}

/** One row, and the problems it produced. */
function parseRow(raw, index, problems) {
  if (!raw || typeof raw !== 'object') {
    problems.push({ kind: 'row_not_an_object', index });
    return null;
  }
  const lower = lowerKeyed(raw);
  const used = new Set();
  const take = (field) => {
    const hit = pick(lower, FIELD_ALIASES[field]);
    for (const key of hit.matched) used.add(key);
    return hit.value;
  };

  // EVERY FIELD IS READ BEFORE THE UNKNOWN-KEY SCAN. Reading them inside the
  // object literal below put the scan first, and it then reported half the
  // Board's real columns as unrecognised — a parser complaining about the
  // fields it was about to read correctly.
  const sheetRowRaw = take('sheetRow');
  const driverNameRaw = text(take('driverName'));
  const truckRaw = text(take('truck'));
  const isTeamRaw = take('isTeam');
  const statusRaw = take('status');
  const boardTrailer = text(take('boardTrailer'));
  const phone = text(take('phone'));
  const etaText = text(take('etaText'));
  const originDelivery = text(take('originDelivery'));
  const notes = text(take('notes'));
  const dispatcher = text(take('dispatcher'));
  const lastUpdatedBy = text(take('lastUpdatedBy'));

  const fleet = parseFleetLabel(driverNameRaw || '');
  const team = detectTeam(fleet.cleanName, isTeamRaw);
  const status = parseStatus(statusRaw);

  // Names only. A value could be a driver's phone number.
  for (const key of Object.keys(lower)) {
    if (!used.has(key)) problems.push({ kind: 'unknown_field', field: key, index });
  }
  if (!driverNameRaw) problems.push({ kind: 'row_without_driver', index });
  if (!truckRaw) problems.push({ kind: 'row_without_truck', index });
  if (fleet.normalised) problems.push({ kind: 'fleet_label_typo', index, label: fleet.label });
  if (fleet.fleetType === FLEET_TYPES.UNKNOWN && driverNameRaw) {
    problems.push({ kind: 'unknown_fleet_label', index, label: fleet.label });
  }
  if (!status.known) problems.push({ kind: 'unknown_status', index, status: status.status });
  if (team.flagMismatch) problems.push({ kind: 'team_flag_mismatch', index });

  const row = {
    sheetRow: Number.isFinite(Number(sheetRowRaw)) ? Number(sheetRowRaw) : index + 1,
    driverNameRaw,
    cleanName: fleet.cleanName || null,
    fleetType: fleet.fleetType,
    fleetLabelRaw: fleet.label,
    fleetLabelNormalised: fleet.normalised,
    isTeam: team.isTeam,
    teamMembers: team.members,
    teamFlagMismatch: team.flagMismatch,
    truckRaw,
    truckNorm: normalizeBoardTruck(truckRaw),
    truckDigits: digitsOnlyTruck(truckRaw),
    boardTrailer,
    phone,
    status: status.status,
    statusRaw: status.raw,
    etaText,
    originDelivery,
    notes,
    dispatcher,
    lastUpdatedBy,
    rowKeyCollision: false,
  };
  row.rowKey = boardRowKey(row);
  if (!row.rowKey) problems.push({ kind: 'row_cannot_be_identified', index });
  return row;
}

/**
 * @param {*} payload  whatever the Board returned, already JSON-parsed
 * @returns {{ok: boolean, boardDate: string|null, generatedAt: string|null,
 *   count: number, rows: object[], problems: object[]}}
 */
function parseBoardPayload(payload) {
  const problems = [];
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false, boardDate: null, generatedAt: null, count: 0, rows: [],
      problems: [{ kind: 'payload_not_an_object' }],
    };
  }

  const lower = lowerKeyed(payload);
  let rawRows = null;
  for (const key of ROW_KEYS) {
    if (Array.isArray(lower[key])) { rawRows = lower[key]; break; }
  }
  // An Apps Script that returns the array itself, with no envelope.
  if (!rawRows && Array.isArray(payload)) rawRows = payload;
  if (!rawRows) {
    return {
      ok: false, boardDate: null, generatedAt: null, count: 0, rows: [],
      problems: [{ kind: 'no_rows_found', fields: Object.keys(lower) }],
    };
  }

  const rows = [];
  const seen = new Map();
  rawRows.forEach((raw, index) => {
    const row = parseRow(raw, index, problems);
    if (!row) return;
    // TWO ROWS, ONE NAME. Both are kept — dropping one would silently lose a
    // driver — and the collision is reported so somebody fixes the Board.
    if (row.rowKey && seen.has(row.rowKey)) {
      problems.push({ kind: 'duplicate_row_key', index, firstIndex: seen.get(row.rowKey) });
      // BOTH rows carry the flag, not just the second. The snapshot is keyed by
      // `row_key`, so these two lines collapse into one stored row and one
      // assignment is lost — and which of them wins depends on sheet order.
      // Inventing a distinguishing key would be worse: it would not survive the
      // sheet being sorted, so the same driver would appear to change identity.
      // So Wenze says it cannot tell them apart, and a person fixes the board.
      row.rowKeyCollision = true;
      const first = rows.find((r) => r.rowKey === row.rowKey);
      if (first) first.rowKeyCollision = true;
    } else if (row.rowKey) {
      seen.set(row.rowKey, index);
    }
    rows.push(row);
  });

  return {
    ok: true,
    boardDate: text(pick(lower, META_ALIASES.boardDate).value),
    generatedAt: text(pick(lower, META_ALIASES.generatedAt).value),
    count: rows.length,
    rows,
    problems,
  };
}

/** Counts only — safe to return from an API and to put on a screen. */
function summariseBoardPayload(parsed) {
  const fleet = { company: 0, lease: 0, owner_operator: 0, unknown: 0 };
  const status = {};
  let teams = 0;
  let normalisedLabels = 0;
  for (const row of parsed?.rows || []) {
    if (fleet[row.fleetType] !== undefined) fleet[row.fleetType] += 1;
    status[row.status] = (status[row.status] || 0) + 1;
    if (row.isTeam) teams += 1;
    if (row.fleetLabelNormalised) normalisedLabels += 1;
  }
  const problemKinds = {};
  for (const p of parsed?.problems || []) {
    problemKinds[p.kind] = (problemKinds[p.kind] || 0) + 1;
  }
  return {
    count: parsed?.count || 0, fleet, status, teams, normalisedLabels, problemKinds,
  };
}

module.exports = {
  parseBoardPayload,
  summariseBoardPayload,
  parseRow,
  detectTeam,
  parseStatus,
  KNOWN_STATUSES,
  FIELD_ALIASES,
};
