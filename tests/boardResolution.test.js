'use strict';

/**
 * Who a Dispatcher Board row is about.
 *
 * THE TESTS THAT MATTER HERE ARE THE REFUSALS. Linking a Board row to the
 * wrong person moves that person's truck, their home-time clock and their
 * bonus, so most of this file is about the cases where the module declines to
 * answer — a shared surname, a bare number, a disagreement between two sources,
 * a team pair that collapses onto one person.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideBoardLink, decideTeamBoardLink, namesAgreeStrictly, sameFleet, CHECKS,
  LINK_CONFIDENCE, SUGGEST_CONFIDENCE,
} = require('../lib/identity/boardResolution');

const ROW = { cleanName: 'JOHN SMITH', fleetType: 'company', truckNorm: '001', personId: null };

function holder(over = {}) {
  return {
    personId: 5, displayName: 'JOHN SMITH', fleetType: 'company', seat: 1, truckExact: true, ...over,
  };
}

// ── both facts agree: the only case that may act ─────────────────────────────

test('the truck and the name both say one person — link', () => {
  const got = decideBoardLink({ row: ROW, unitHolders: [holder()] });
  assert.equal(got.action, 'link');
  assert.equal(got.personId, 5);
  assert.equal(got.confidence, LINK_CONFIDENCE);
});

test('a middle name or a suffix is forgiven', () => {
  for (const name of ['JOHN A SMITH', 'JOHN SMITH JR', 'SMITH JOHN']) {
    const got = decideBoardLink({ row: ROW, unitHolders: [holder({ displayName: name })] });
    assert.equal(got.action, 'link', name);
  }
});

// ── the refusals ─────────────────────────────────────────────────────────────

test('A SHARED SURNAME IS NEVER A LINK — two brothers are two people', () => {
  const got = decideBoardLink({ row: ROW, unitHolders: [holder({ displayName: 'PETER SMITH' })] });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.CONFLICT);
  assert.equal(got.personId, null);
});

test('A SHARED SURNAME IS NOT EVEN A SUGGESTION', () => {
  // The loose matcher would say yes here. A suggestion carries an implicit
  // "probably" that a shared surname has not earned.
  const got = decideBoardLink({
    row: ROW, nameCandidates: [{ personId: 9, displayName: 'PETER SMITH', fleetType: 'company' }],
  });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.AMBIGUOUS);
});

test('A DIGITS-ONLY TRUCK MATCH MAY NEVER ACT', () => {
  // 001, 1 and 001A reduce to the same digits and are three trucks.
  const got = decideBoardLink({ row: ROW, unitHolders: [holder({ truckExact: false })] });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.AMBIGUOUS);
});

test('the board and the records disagreeing is a QUESTION, never a tie-break', () => {
  const got = decideBoardLink({ row: ROW, unitHolders: [holder({ displayName: 'MARIA GARCIA' })] });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.CONFLICT);
  assert.equal(got.holderPersonId, 5, 'the finding names who we thought it was');
});

test('two people recorded in one truck is a question, not a choice', () => {
  const got = decideBoardLink({
    row: ROW, unitHolders: [holder(), holder({ personId: 6, seat: 2 })],
  });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.AMBIGUOUS);
});

test('one name matching two people is a question', () => {
  const got = decideBoardLink({
    row: ROW,
    nameCandidates: [
      { personId: 9, displayName: 'JOHN SMITH', fleetType: 'company' },
      { personId: 10, displayName: 'JOHN SMITH', fleetType: 'lease' },
    ],
  });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.AMBIGUOUS);
});

test('nobody at all is an unmatched row, not an error', () => {
  const got = decideBoardLink({ row: ROW });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.UNMATCHED);
});

test('a row naming nobody is unmatched rather than crashing', () => {
  for (const name of ['', '   ', null]) {
    const got = decideBoardLink({ row: { ...ROW, cleanName: name } });
    assert.equal(got.checkKey, CHECKS.UNMATCHED, String(name));
  }
});

// ── fleet ────────────────────────────────────────────────────────────────────

test('A DIFFERENT FLEET IS A DIFFERENT TRUCK — the holder is not in the way', () => {
  // Company 001 and Lease 001 are two trucks. A lease holder says nothing
  // about a company row, so the decision falls through to the name.
  const got = decideBoardLink({
    row: ROW,
    unitHolders: [holder({ fleetType: 'lease', displayName: 'SOMEBODY ELSE' })],
    nameCandidates: [{ personId: 9, displayName: 'JOHN SMITH', fleetType: 'company' }],
  });
  assert.equal(got.action, 'suggest');
  assert.equal(got.personId, 9);
});

test('UNKNOWN NEVER WINS A MATCH, in either direction', () => {
  assert.equal(sameFleet('unknown', 'company'), false);
  assert.equal(sameFleet('company', 'unknown'), false);
  assert.equal(sameFleet('unknown', 'unknown'), false);
  assert.equal(sameFleet('company', 'company'), true);
  assert.equal(sameFleet('company', 'lease'), false);

  // So an unknown-fleet row cannot be linked off its truck, however well the
  // name agrees — the truck is not identified.
  const got = decideBoardLink({
    row: { ...ROW, fleetType: 'unknown' }, unitHolders: [holder()],
  });
  assert.notEqual(got.action, 'link');
});

// ── one fact only: a suggestion for a person ─────────────────────────────────

test('a name that matches one person, with nobody in the truck — suggest', () => {
  const got = decideBoardLink({
    row: ROW, nameCandidates: [{ personId: 9, displayName: 'JOHN SMITH', fleetType: 'company' }],
  });
  assert.equal(got.action, 'suggest');
  assert.equal(got.confidence, SUGGEST_CONFIDENCE);
});

// ── a row already decided ────────────────────────────────────────────────────

test('a row already linked and still consistent is left alone', () => {
  const got = decideBoardLink({
    row: { ...ROW, personId: 5 }, unitHolders: [holder()],
  });
  assert.equal(got.action, 'none');
});

test('a link made by hand is not second-guessed when the truck has no holder', () => {
  const got = decideBoardLink({ row: { ...ROW, personId: 77 } });
  assert.equal(got.action, 'none');
  assert.equal(got.personId, 77);
});

test('a row linked to somebody the truck no longer belongs to is a conflict', () => {
  const got = decideBoardLink({
    row: { ...ROW, personId: 77 }, unitHolders: [holder({ personId: 5 })],
  });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.CONFLICT);
  assert.equal(got.linkedPersonId, 77);
});

// ── teams ────────────────────────────────────────────────────────────────────

test('a team is two people on one truck, decided separately', () => {
  const { members, conflict } = decideTeamBoardLink({
    row: { ...ROW, isTeam: true, cleanName: 'JOHN SMITH / MARIA GARCIA' },
    members: ['JOHN SMITH', 'MARIA GARCIA'],
    lookupFor: (name) => ({
      nameCandidates: name === 'JOHN SMITH'
        ? [{ personId: 9, displayName: 'JOHN SMITH', fleetType: 'company' }]
        : [{ personId: 10, displayName: 'MARIA GARCIA', fleetType: 'company' }],
    }),
  });
  assert.equal(conflict, null);
  assert.deepEqual(members.map((m) => m.personId), [9, 10]);
});

test('BOTH TEAM MEMBERS RESOLVING TO ONE PERSON LINKS NEITHER', () => {
  // A composite "A / B" person stored years ago. Splitting it is a judgement
  // about two humans; linking one of them silently picks a winner.
  const { members, conflict } = decideTeamBoardLink({
    row: { ...ROW, isTeam: true },
    members: ['JOHN SMITH', 'MARIA GARCIA'],
    lookupFor: () => ({
      nameCandidates: [{ personId: 9, displayName: 'JOHN SMITH MARIA GARCIA', fleetType: 'company' }],
    }),
  });
  assert.equal(conflict.checkKey, CHECKS.TEAM_SPLIT);
  for (const m of members) {
    assert.equal(m.action, 'ask');
    assert.equal(m.personId, null);
    assert.equal(m.checkKey, CHECKS.TEAM_SPLIT);
  }
});

// ── the strict matcher itself ────────────────────────────────────────────────

test('strict name agreement: what it accepts and what it will not', () => {
  assert.equal(namesAgreeStrictly('JOHN SMITH', 'john smith'), true);
  assert.equal(namesAgreeStrictly('JOHN SMITH', 'JOHN A SMITH'), true);
  assert.equal(namesAgreeStrictly('JOHN SMITH', 'PETER SMITH'), false);
  assert.equal(namesAgreeStrictly('JOHN SMITH', 'SMITH'), false, 'a surname alone is not a person');
  assert.equal(namesAgreeStrictly('JOHN', 'JOHN SMITH'), false, 'one word is never enough');
  assert.equal(namesAgreeStrictly('', 'JOHN SMITH'), false);
  assert.equal(namesAgreeStrictly(null, null), false);
});
