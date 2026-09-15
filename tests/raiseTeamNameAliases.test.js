'use strict';

/**
 * The production shape: teams are NAMED after the people who run them, and
 * `dispatch_team_members` is EMPTY.
 *
 * THIS IS THE GAP THAT SHIPPED TWICE. The matcher had two sources for a
 * dispatcher's name — the team's name and its member list — and production
 * populates neither the way the code assumed. Real team names are
 *
 *     "Aaron / Jack"            "Franky / Sam / Ali"
 *     "Anthony / Andy / James"
 *
 * and there are no member rows at all. The given-name tier reads the FIRST
 * word, so exactly one name per team resolved: Aaron matched and Jack did not,
 * Franky matched and Sam and Ali did not. A board row reading "zAaron/Jack"
 * then failed the unanimity rule on a name that was written on the team all
 * along, and the driver went to Needs Review every week.
 *
 * Every fixture here therefore uses `memberNames: []` ON PURPOSE. A test that
 * quietly supplies members is testing a database this company does not have,
 * which is precisely how the gap survived the previous round.
 *
 * The second half is the line that must not move: reading the team name as a
 * list of aliases buys nothing if it also lets a driver onto the wrong team.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { DECISION, VIA, MATCHED_ON, matchDispatcherToTeam } = require('../lib/raise/dispatcherTeam');

/** The real structure: several names per team, and NO member rows. */
const TEAMS = [
  { id: 1, name: 'Aaron / Jack', memberNames: [] },
  { id: 2, name: 'Franky / Sam / Ali', memberNames: [] },
  { id: 3, name: 'Anthony / Andy / James', memberNames: [] },
  { id: 4, name: 'Charles', memberNames: [] },
  { id: 5, name: 'Steven', memberNames: [] },
];

const match = (label) => matchDispatcherToTeam(label, TEAMS);

test('EVERY name inside a team name reaches that team, not just the first', () => {
  const expected = [
    ['Aaron', 1], ['Jack', 1],
    ['Franky', 2], ['Sam', 2], ['Ali', 2],
    ['Anthony', 3], ['Andy', 3], ['James', 3],
    ['Charles', 4], ['Steven', 5],
  ];
  for (const [label, teamId] of expected) {
    const m = match(label);
    assert.equal(m.decision, DECISION.MATCHED, `${label} must resolve`);
    assert.equal(m.teamId, teamId, label);
  }
});

test('the second and third names are the ones that used to be lost', () => {
  // Named separately because this is the exact regression: with the member
  // table empty, only the team name's FIRST word was ever a key.
  for (const [label, teamId] of [['Jack', 1], ['Sam', 2], ['Ali', 2], ['Andy', 3], ['James', 3]]) {
    const m = match(label);
    assert.equal(m.decision, DECISION.MATCHED, `${label} used to be unknown`);
    assert.equal(m.teamId, teamId, label);
    assert.ok(
      [MATCHED_ON.TEAM_NAME_PART, MATCHED_ON.TEAM_NAME_PART_GIVEN].includes(m.matchedOn),
      `${label} resolves through the team's own name, not a member row`
    );
  }
});

test('"zAaron/Jack" resolves — the case the whole production gap was about', () => {
  const m = match('zAaron/Jack');
  assert.equal(m.decision, DECISION.MATCHED);
  assert.equal(m.teamId, 1);
  assert.equal(m.via, VIA.MULTI_NAME, 'both names had to resolve and agree');
});

test('the sorting-marked labels still work against the real team shape', () => {
  for (const [label, teamId] of [['x Franky', 2], ['y Anthony', 3], ['x Sam', 2], ['y James', 3]]) {
    const m = match(label);
    assert.equal(m.decision, DECISION.MATCHED, label);
    assert.equal(m.teamId, teamId, label);
    assert.equal(m.via, VIA.SORT_MARKER, label);
  }
});

test('a team name written out in full still matches itself first', () => {
  for (const [label, teamId] of [['Aaron / Jack', 1], ['Franky / Sam / Ali', 2], ['Anthony/Andy/James', 3]]) {
    const m = match(label);
    assert.equal(m.decision, DECISION.MATCHED, label);
    assert.equal(m.teamId, teamId, label);
    assert.equal(m.via, VIA.LITERAL, 'the whole name is the strongest evidence and is tried first');
  }
});

test('two names from the SAME team on one row is that team', () => {
  for (const label of ['Sam/Ali', 'Franky & Ali', 'Andy, James', 'Jack/Aaron']) {
    const m = match(label);
    assert.equal(m.decision, DECISION.MATCHED, label);
    assert.ok([1, 2, 3].includes(m.teamId), label);
  }
});

// ─── the strictness that must survive the new aliases ───

test('two names from DIFFERENT teams is AMBIGUOUS, never one of them', () => {
  const m = match('Jack/Sam');
  assert.equal(m.decision, DECISION.AMBIGUOUS);
  assert.equal(m.teamId, null);
  assert.deepEqual([...m.candidates].sort(), [1, 2]);
});

test('a known name beside an unknown one is still refused', () => {
  const m = match('Jack/Nobody');
  assert.equal(m.decision, DECISION.UNKNOWN);
  assert.equal(m.teamId, null);
});

test('a SURNAME never becomes an alias — only explicit separators split a name', () => {
  // "Charles Whitfield" is one person. If team names were split on whitespace,
  // "Whitfield" would silently become a way to reach that team, and so would
  // half of every two-word name in the company.
  const teams = [{ id: 1, name: 'Charles Whitfield', memberNames: [] }, { id: 2, name: 'Steven', memberNames: [] }];
  assert.equal(matchDispatcherToTeam('Whitfield', teams).decision, DECISION.UNKNOWN);
  assert.equal(matchDispatcherToTeam('Charles', teams).teamId, 1, 'the given-name tier still works');
  assert.equal(matchDispatcherToTeam('Charles Whitfield', teams).teamId, 1);
});

test('a COMMA in a team name is a surname, not a list — no alias from it', () => {
  // A team name and a board label are not equally safe to split. Splitting a
  // LABEL wrongly costs a refusal; splitting a TEAM NAME wrongly costs a wrong
  // KEY, and from then on any cell carrying that word places a driver there.
  // The comma is the one mark that means both "and another person" and "one
  // person, surname first", so a team name is never split on it.
  const teams = [{ id: 1, name: 'John, Smith', memberNames: [] }, { id: 2, name: 'Steven', memberNames: [] }];
  assert.equal(matchDispatcherToTeam('Smith', teams).decision, DECISION.UNKNOWN,
    'a surname must not become a way to reach a team');
  assert.equal(matchDispatcherToTeam('John', teams).teamId, 1, 'the given-name tier still works');
  assert.equal(matchDispatcherToTeam('John, Smith', teams).teamId, 1, 'and the full name still matches itself');
});

test('the separators that DO mean another person still make aliases', () => {
  for (const name of ['Aaron / Jack', 'Aaron & Jack', 'Aaron + Jack', 'Aaron and Jack', 'Aaron; Jack']) {
    const teams = [{ id: 1, name, memberNames: [] }];
    assert.equal(matchDispatcherToTeam('Jack', teams).teamId, 1, name);
    assert.equal(matchDispatcherToTeam('Aaron', teams).teamId, 1, name);
  }
});

test('one name on TWO teams is ambiguous, not a race between them', () => {
  // Aliases go through the same Set-keyed index as every other name, so a
  // collision is reported rather than resolved by iteration order.
  const teams = [{ id: 1, name: 'Aaron / Jack', memberNames: [] }, { id: 2, name: 'Jack / Bob', memberNames: [] }];
  const m = matchDispatcherToTeam('Jack', teams);
  assert.equal(m.decision, DECISION.AMBIGUOUS);
  assert.deepEqual([...m.candidates].sort(), [1, 2]);
  assert.equal(matchDispatcherToTeam('Aaron', teams).teamId, 1, 'the unshared names still resolve');
  assert.equal(matchDispatcherToTeam('Bob', teams).teamId, 2);
});

test('a name on no team at all is still unknown', () => {
  for (const label of ['Nobody', 'Zachary', 'Yusuf', 'ZAARON', 'x Nobody']) {
    assert.equal(match(label).decision, DECISION.UNKNOWN, label);
  }
});

test('an empty cell is EMPTY, not a team', () => {
  for (const label of ['', '   ', null, undefined]) {
    assert.equal(match(label).decision, DECISION.EMPTY, JSON.stringify(label));
  }
});

test('a noise word inside a team name does not become an alias', () => {
  // "Dispatch / Charles" is Charles's team; "dispatch" is not a person and
  // must not become a key that matches every board cell reading "dispatch".
  const teams = [{ id: 1, name: 'Dispatch / Charles', memberNames: [] }];
  assert.equal(matchDispatcherToTeam('Charles', teams).teamId, 1);
  assert.equal(matchDispatcherToTeam('dispatch', teams).decision, DECISION.EMPTY,
    'a pure noise label names nobody');
});
