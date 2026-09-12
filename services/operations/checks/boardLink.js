/**
 * Joining a Dispatcher Board row to a person — pure, no I/O.
 *
 * `services/operations/checks/board.js` reports on the BOARD ITSELF: a label
 * nobody recognises, a truck on two rows. This file is the one that compares
 * the Board with Wenze, which is a different question with different evidence
 * rules, and that is why it is a separate module rather than two more functions
 * over there.
 *
 * ALL THE JUDGEMENT LIVES IN `lib/identity/boardResolution.js`. This file loads
 * candidates out of the snapshot and turns one decision into one finding; it
 * decides nothing itself. That separation is what lets the rule that can merge
 * two people be read and tested as plain values.
 *
 * THE TIERS, and the reason for each:
 *
 *   `board.person_link`            tier `auto`. The truck AND the name agree,
 *                                  the truck by its exact spelling. This is the
 *                                  only case anything is written, and it is
 *                                  still gated by the check's mode — it ships
 *                                  in `suggest`, so nothing links until the
 *                                  owner says it may.
 *   `board.person_link_suggested`  tier `approval`. One fact only.
 *   `board.person_link_conflict`   tier `warning`. Two sources disagree. There
 *                                  is nothing to propose: picking either would
 *                                  be a guess with somebody's bonus attached.
 *   `board.person_link_ambiguous`  tier `warning`.
 *   `board.person_unmatched`       tier `warning`, severity `info`. Ordinary on
 *                                  a fleet whose board is ahead of its records.
 *   `board.team_person_needs_split` tier `approval`. Two names, one person row.
 */
const {
  decideBoardLink, decideTeamBoardLink, CHECKS,
} = require('../../../lib/identity/boardResolution');
const { digitsOnlyTruck } = require('../../../lib/board/truck');

const CHECK_KEYS = [
  'board.person_link',
  'board.person_link_suggested',
  CHECKS.CONFLICT,
  CHECKS.AMBIGUOUS,
  CHECKS.UNMATCHED,
  CHECKS.TEAM_SPLIT,
];

/** Rows still on the board. An absent row is history, not today's truth. */
function presentRows(boardRows) {
  return (boardRows || []).filter((r) => r && r.present && r.rowKey);
}

/**
 * Index the person layer once per sweep rather than per row.
 *
 * A hundred board rows against two hundred open units is twenty thousand
 * comparisons done the naive way, every fifteen minutes, to answer a question
 * that is mostly "no".
 */
function indexLayer(layer) {
  const nameOf = new Map();
  for (const p of layer?.people || []) {
    if (p.merged_into_person_id == null) nameOf.set(p.id, p.display_name || '');
  }
  const byUnit = new Map();
  for (const u of layer?.units || []) {
    const exact = String(u.unit_number || '').trim().toUpperCase();
    if (!exact) continue;
    const entry = {
      personId: u.person_id,
      displayName: nameOf.get(u.person_id) || '',
      fleetType: u.fleet_type || 'unknown',
      seat: u.seat == null ? 1 : Number(u.seat),
      exact,
    };
    if (!byUnit.has(exact)) byUnit.set(exact, []);
    byUnit.get(exact).push(entry);
  }
  return { nameOf, byUnit };
}

/**
 * Who might this name be?
 *
 * Every canonical person is a candidate; the RULE decides which of them agrees
 * closely enough to matter. Filtering here with a looser test would hide the
 * ambiguity the rule exists to report.
 */
function candidatesFor(index) {
  return [...index.nameOf.entries()].map(([personId, displayName]) => ({
    personId, displayName, fleetType: null,
  }));
}

function holdersFor(row, index) {
  const exact = String(row.truckNorm || '').trim().toUpperCase();
  if (!exact) return [];
  const direct = index.byUnit.get(exact) || [];
  if (direct.length) return direct.map((h) => ({ ...h, truckExact: true }));

  // NOTHING ON THE EXACT SPELLING. The digits-only form may still find
  // somebody, and the rule will refuse to act on it — but a match it never saw
  // is reported as "nobody is in this truck", which is a different and wrong
  // answer.
  const digits = String(row.truckDigits || '').trim();
  if (!digits) return [];
  const loose = [];
  for (const [unit, holders] of index.byUnit.entries()) {
    if (digitsOnlyTruck(unit) === digits) {
      loose.push(...holders.map((h) => ({ ...h, truckExact: false })));
    }
  }
  return loose;
}

function findingFor(row, decision, { name = null } = {}) {
  const who = name || row.cleanName || row.rowKey;
  const base = {
    subjectType: 'board_row',
    subjectId: name ? `${row.rowKey}|${name}` : row.rowKey,
    evidence: {
      rowKey: row.rowKey,
      driver: who,
      truck: row.truckNorm,
      fleetType: row.fleetType,
      isTeam: row.isTeam === true,
      reason: decision.reason,
      ...(decision.holderPersonId ? { recordedPersonId: decision.holderPersonId } : {}),
      ...(decision.linkedPersonId ? { linkedPersonId: decision.linkedPersonId } : {}),
    },
    // NOTHING HERE PROPOSES A CHANGE except the link itself. A disagreement
    // between two systems is not evidence about which one is right.
    proposedChange: null,
  };

  if (decision.action === 'link') {
    return {
      ...base,
      checkKey: 'board.person_link',
      title: `The board row for ${who} matches one person in Wenze`,
      severity: 'info',
      tier: 'auto',
      confidence: decision.confidence,
      proposedChange: { rowKey: row.rowKey, personId: decision.personId, linkSource: 'board' },
    };
  }
  if (decision.action === 'suggest') {
    return {
      ...base,
      checkKey: 'board.person_link_suggested',
      title: `The board row for ${who} looks like one person, on the name alone`,
      severity: 'info',
      tier: 'approval',
      confidence: decision.confidence,
      proposedChange: { rowKey: row.rowKey, personId: decision.personId, linkSource: 'board' },
    };
  }

  const WORDING = {
    [CHECKS.CONFLICT]: `The board and Wenze disagree about who is driving ${row.truckNorm || 'this truck'}`,
    [CHECKS.AMBIGUOUS]: `Wenze cannot tell which person the board row for ${who} is about`,
    [CHECKS.UNMATCHED]: `The board row for ${who} matches nobody in Wenze`,
    [CHECKS.TEAM_SPLIT]: `Both team drivers on ${row.truckNorm || 'this truck'} are recorded as one person`,
  };
  return {
    ...base,
    checkKey: decision.checkKey,
    title: WORDING[decision.checkKey] || `The board row for ${who} could not be placed`,
    severity: decision.checkKey === CHECKS.UNMATCHED ? 'info' : 'warning',
    tier: decision.checkKey === CHECKS.TEAM_SPLIT ? 'approval' : 'warning',
    confidence: 100,
  };
}

/**
 * @param {object} snapshot  THE PERSON LAYER IS SPREAD ACROSS THE SNAPSHOT, not
 *   nested under `layer` — `loadSnapshot` does `...layer`, so `people` and
 *   `units` sit at the top level exactly as `checks/identityLayer.js` reads
 *   them. Reading a `layer` property here found `undefined` and filed nothing,
 *   silently: the module ran, returned an empty list, and looked like a fleet
 *   with nothing to link.
 */
function runBoardLinkChecks(snapshot = {}) {
  const { boardRows } = snapshot;
  const rows = presentRows(boardRows);
  const layer = snapshot.layer || snapshot;
  if (!rows.length || !Array.isArray(layer.people)) return [];
  const index = indexLayer(layer);
  const nameCandidates = candidatesFor(index);
  const findings = [];

  for (const row of rows) {
    const unitHolders = holdersFor(row, index);

    if (row.isTeam && Array.isArray(row.teamMembers) && row.teamMembers.length > 1) {
      const { members } = decideTeamBoardLink({
        row,
        members: row.teamMembers,
        lookupFor: () => ({ unitHolders, nameCandidates }),
      });
      for (const member of members) {
        if (member.action === 'none') continue;
        findings.push(findingFor(row, member, { name: member.name }));
      }
      continue;
    }

    const decision = decideBoardLink({ row, unitHolders, nameCandidates });
    if (decision.action === 'none') continue;
    findings.push(findingFor(row, decision));
  }
  return findings;
}

module.exports = { CHECK_KEYS, runBoardLinkChecks, indexLayer, holdersFor };
