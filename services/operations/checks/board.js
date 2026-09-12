/**
 * Dispatcher Board checks — pure, no I/O.
 *
 * The Board is the authority on who is in which truck today, and these checks
 * are what keeps that authority HONEST. Every one of them reports something
 * about the BOARD ITSELF — a label nobody recognises, a status that is not in
 * the vocabulary, one truck on two rows — and not one of them compares the
 * Board with Wenze. That comparison is a later stage with its own evidence
 * rules, and folding it in here would put "the spreadsheet has a typo" and
 * "the two systems disagree about a driver" behind one switch.
 *
 * EVERY CHECK HERE IS REPORT-ONLY (`tier: 'warning'`). Nothing in this file
 * proposes a change, because nothing in a spreadsheet read is evidence about
 * which of two disagreeing records is right. A row nobody can interpret is a
 * question for the person who maintains the board, not a correction.
 */
const { KNOWN_STATUSES } = require('../../../lib/board/parse');

/** Rows still on the board. An absent row is history, not today's truth. */
function presentRows(boardRows) {
  return (boardRows || []).filter((r) => r && r.present);
}

function nameOf(row) {
  return row.cleanName || row.rowKey || 'an unnamed row';
}

/**
 * A fleet label the parser could not place.
 *
 * `unknown` NEVER WINS A MATCH downstream, so a row that lands here is a row
 * that will not be linked to a person, will not be compared against Wenze, and
 * will look — to everything except this check — exactly like a row nobody has
 * got to yet. Warning, not info, for that reason: it is silently inert.
 */
function checkUnknownFleetLabel({ boardRows }) {
  return presentRows(boardRows)
    .filter((r) => r.fleetType === 'unknown' && r.fleetLabelRaw)
    .map((r) => ({
      checkKey: 'board.unknown_fleet_label',
      subjectType: 'board_row',
      subjectId: r.rowKey,
      title: `The board labels ${nameOf(r)} "${r.fleetLabelRaw}", which Wenze does not recognise`,
      severity: 'warning',
      tier: 'warning',
      confidence: 100,
      evidence: {
        rowKey: r.rowKey,
        driver: r.cleanName,
        truck: r.truckNorm,
        label: r.fleetLabelRaw,
        recognised: ['(COMPANY DRIVER)', '(LEASE DRIVER)', 'no label = owner operator'],
        consequence: 'an unrecognised fleet type is never matched to a person',
      },
      proposedChange: null,
    }));
}

/**
 * A label Wenze read THROUGH a spelling mistake.
 *
 * Info, because nothing is broken — the row was placed correctly. It is worth
 * saying only so the board gets tidied, and so nobody later discovers Wenze has
 * been quietly interpreting a typo and wonders what else it interprets.
 */
function checkFleetLabelTypo({ boardRows }) {
  return presentRows(boardRows)
    .filter((r) => r.fleetLabelNormalised)
    .map((r) => ({
      checkKey: 'board.fleet_label_typo',
      subjectType: 'board_row',
      subjectId: r.rowKey,
      title: `The board spells ${nameOf(r)}'s fleet label "${r.fleetLabelRaw}"`,
      severity: 'info',
      tier: 'warning',
      confidence: 100,
      evidence: {
        rowKey: r.rowKey,
        driver: r.cleanName,
        label: r.fleetLabelRaw,
        readAs: r.fleetType,
      },
      proposedChange: null,
    }));
}

/** A status outside the board's own vocabulary. */
function checkUnknownStatus({ boardRows }) {
  return presentRows(boardRows)
    .filter((r) => r.status && r.status !== 'UNKNOWN' && !KNOWN_STATUSES.includes(r.status))
    .map((r) => ({
      checkKey: 'board.unknown_status',
      subjectType: 'board_row',
      subjectId: r.rowKey,
      title: `The board gives ${nameOf(r)} the status "${r.statusRaw || r.status}"`,
      severity: 'info',
      tier: 'warning',
      confidence: 100,
      evidence: {
        rowKey: r.rowKey,
        driver: r.cleanName,
        status: r.statusRaw || r.status,
        known: KNOWN_STATUSES,
      },
      proposedChange: null,
    }));
}

/**
 * The team column and the name disagree.
 *
 * Two people share one truck or they do not, and the board says so twice — a
 * flag, and a name written "A / B". When those two disagree Wenze cannot tell
 * how many humans the row is about, which is the one thing it must never guess.
 */
function checkTeamFlagMismatch({ boardRows }) {
  return presentRows(boardRows)
    .filter((r) => r.teamFlagMismatch)
    .map((r) => ({
      checkKey: 'board.team_flag_mismatch',
      subjectType: 'board_row',
      subjectId: r.rowKey,
      title: `The board cannot say whether ${nameOf(r)} is one driver or two`,
      severity: 'warning',
      tier: 'warning',
      confidence: 100,
      evidence: {
        rowKey: r.rowKey,
        driver: r.cleanName,
        truck: r.truckNorm,
        teamFlag: r.isTeam,
        note: 'the team column and the written name disagree',
      },
      proposedChange: null,
    }));
}

/**
 * One truck, two rows — WITHIN one fleet.
 *
 * Company 001, Owner-Operator 001 and Lease 001 are three different trucks, so
 * bucketing on the bare number would file a finding about every one of them and
 * teach an operator to ignore this check within a week. The bucket is
 * `fleetType|truck` whenever both rows carry a KNOWN fleet type; when either
 * side is `unknown` the bare number is used, because "we cannot tell them apart"
 * is exactly when a person should look.
 */
function checkTruckOnMultipleRows({ boardRows }) {
  const buckets = new Map();
  for (const row of presentRows(boardRows)) {
    if (!row.truckNorm) continue;
    const key = row.fleetType && row.fleetType !== 'unknown'
      ? `${row.fleetType}|${row.truckNorm}`
      : `unknown|${row.truckNorm}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  // An `unknown` row is indistinguishable from a row of ANY fleet, so it is
  // compared against every bucket that shares its number, not only its own.
  const findings = [];
  for (const [key, rows] of buckets) {
    const [fleet, truck] = key.split('|');
    const shared = fleet === 'unknown'
      ? rows
      : rows.concat(buckets.get(`unknown|${truck}`) || []);
    if (shared.length < 2) continue;
    findings.push({
      checkKey: 'board.truck_on_multiple_rows',
      subjectType: 'board_truck',
      subjectId: key,
      title: `Truck ${truck} is on ${shared.length} board rows`
        + (fleet === 'unknown' ? '' : ` as a ${fleet.replace('_', ' ')} truck`),
      severity: 'warning',
      tier: 'warning',
      confidence: 100,
      evidence: {
        truck,
        fleetType: fleet,
        rows: shared.map((r) => ({
          rowKey: r.rowKey, driver: r.cleanName, fleetType: r.fleetType, status: r.status,
        })),
        note: 'a team is one row with two names, so two rows on one truck are two assignments',
      },
      proposedChange: null,
    });
  }
  return findings;
}

/**
 * Two board lines that reduce to one row.
 *
 * `row_key` is the truck plus the person, so two lines naming the same driver on
 * the same truck collapse into ONE stored row — and one assignment is simply not
 * in the snapshot. Wenze does not invent a key to tell them apart: a made-up
 * identity would not survive the sheet being sorted, and the same driver would
 * appear to change identity every time somebody reordered the board. So it says
 * it cannot tell them apart, and a person fixes the board.
 *
 * Warning, not info: something the board says is not in Wenze at all, and
 * nothing else in the system can notice that.
 */
function checkDuplicateRowKey({ boardRows }) {
  return presentRows(boardRows)
    .filter((r) => r.keyCollision)
    .map((r) => ({
      checkKey: 'board.duplicate_row_key',
      subjectType: 'board_row',
      subjectId: r.rowKey,
      title: `The board has two lines for ${nameOf(r)} on truck ${r.truckNorm || '?'}`,
      severity: 'warning',
      tier: 'warning',
      confidence: 100,
      evidence: {
        rowKey: r.rowKey,
        driver: r.cleanName,
        truck: r.truckNorm,
        consequence: 'only one of the two lines is in Wenze; the other is not stored',
        note: 'Wenze will not invent a key to separate them — a made-up identity '
          + 'would change whenever the sheet is sorted',
      },
      proposedChange: null,
    }));
}

/** Nobody is measured against a row that left the board a month ago. */
const VANISHED_WINDOW_DAYS = 7;

/**
 * A row that was on the board and is not any more.
 *
 * Info, and only for a week. A driver leaving the board is routine — they left,
 * they are between trucks, the sheet was tidied — so this exists to answer
 * "where did they go" while somebody still remembers, not to accumulate.
 */
function checkRowVanished({ boardRows, now }) {
  const at = now instanceof Date ? now.getTime() : Date.now();
  const cutoff = at - VANISHED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return (boardRows || [])
    .filter((r) => r && !r.present)
    .filter((r) => {
      const seen = r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : NaN;
      return Number.isFinite(seen) && seen >= cutoff;
    })
    .map((r) => ({
      checkKey: 'board.row_vanished',
      subjectType: 'board_row',
      subjectId: r.rowKey,
      title: `${nameOf(r)} is no longer on the dispatcher board`,
      severity: 'info',
      tier: 'warning',
      confidence: 100,
      evidence: {
        rowKey: r.rowKey,
        driver: r.cleanName,
        truck: r.truckNorm,
        lastSeenAt: r.lastSeenAt,
      },
      proposedChange: null,
    }));
}

const CHECKS = [
  checkUnknownFleetLabel,
  checkDuplicateRowKey,
  checkFleetLabelTypo,
  checkUnknownStatus,
  checkTeamFlagMismatch,
  checkTruckOnMultipleRows,
  checkRowVanished,
];

const CHECK_KEYS = [
  'board.unknown_fleet_label',
  'board.duplicate_row_key',
  'board.fleet_label_typo',
  'board.unknown_status',
  'board.team_flag_mismatch',
  'board.truck_on_multiple_rows',
  'board.row_vanished',
];

function runBoardChecks(snapshot) {
  return CHECKS.flatMap((check) => check(snapshot));
}

module.exports = {
  CHECK_KEYS,
  runBoardChecks,
  checkUnknownFleetLabel,
  checkDuplicateRowKey,
  checkFleetLabelTypo,
  checkUnknownStatus,
  checkTeamFlagMismatch,
  checkTruckOnMultipleRows,
  checkRowVanished,
  VANISHED_WINDOW_DAYS,
};
