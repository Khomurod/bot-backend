'use strict';

/**
 * The dispatcher labels the REAL Dispatcher Board actually contains.
 *
 * Production does not write "Charles" into every cell. It writes sorting
 * markers so rows land where dispatch wants them in the spreadsheet, and it
 * puts two dispatchers on one truck's row:
 *
 *   "x Franky"      marker, space, name
 *   "y Anthony"     the same
 *   "zAaron/Jack"   marker glued to the name, and two dispatchers
 *
 * All three used to come back UNKNOWN, so those company drivers reached Needs
 * Review every single week and were never placed automatically. `x Franky`
 * failed because the given-name tier reads the first word and "X" is below the
 * one-letter floor that stops an initial matching three people, so the tier
 * never ran at all.
 *
 * THE OTHER HALF OF THIS FILE IS THE LINE THAT MUST NOT MOVE. Reading these
 * shapes buys nothing if it also lets a driver onto the wrong team, so every
 * tolerant case here is paired with a refusal: a real name beginning with x, y
 * or z keeps its letter, a label naming two teams is refused, and a label
 * naming one dispatcher Wenze knows and one it does not is refused too — the
 * unknown name may be a dispatcher on another team who has not been registered.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DECISION, VIA, stripSortMarker, splitDispatcherNames, matchDispatcherToTeam,
} = require('../lib/raise/dispatcherTeam');

/** Teams shaped like the real ones: named after the dispatcher who runs them. */
const TEAMS = [
  { id: 1, name: 'Charles', memberNames: ['Charles Whitfield'] },
  { id: 2, name: 'Steven', memberNames: ['Steven Ruiz'] },
  { id: 3, name: 'Allen', memberNames: ['Allen Park'] },
  { id: 4, name: 'Franky', memberNames: ['Franky Mercado'] },
  { id: 5, name: 'Anthony', memberNames: ['Anthony Bell'] },
  { id: 6, name: 'Aaron', memberNames: ['Aaron Cole', 'Jack Nunes'] },
];

const match = (label) => matchDispatcherToTeam(label, TEAMS);

// ─── the three shapes production actually writes ───

test('"x Franky" is Franky — the sorting marker is not part of the name', () => {
  const m = match('x Franky');
  assert.equal(m.decision, DECISION.MATCHED);
  assert.equal(m.teamId, 4);
  assert.equal(m.via, VIA.SORT_MARKER);
});

test('"y Anthony" is Anthony', () => {
  const m = match('y Anthony');
  assert.equal(m.decision, DECISION.MATCHED);
  assert.equal(m.teamId, 5);
  assert.equal(m.via, VIA.SORT_MARKER);
});

test('"zAaron/Jack" is Aaron and Jack, who are one team', () => {
  const m = match('zAaron/Jack');
  assert.equal(m.decision, DECISION.MATCHED);
  assert.equal(m.teamId, 6);
  assert.equal(m.via, VIA.MULTI_NAME);
});

test('the label is reported verbatim whatever it took to read it', () => {
  // Evidence must show what dispatch typed, not what Wenze made of it — a
  // person auditing the placement is checking the board, not the parser.
  assert.equal(match('x Franky').normalised, 'X FRANKY');
  assert.equal(match('zAaron/Jack').normalised, 'ZAARON JACK');
});

// ─── the ordinary labels keep working exactly as before ───

test('plain dispatcher names are matched literally, untouched by any of this', () => {
  for (const [label, teamId] of [['Charles', 1], ['Steven', 2], ['Allen', 3]]) {
    const m = match(label);
    assert.equal(m.decision, DECISION.MATCHED, label);
    assert.equal(m.teamId, teamId, label);
    assert.equal(m.via, VIA.LITERAL, `${label} must not need a fallback`);
  }
});

test('a full name still reaches its team, and still beats the given-name tier', () => {
  const m = match('Charles Whitfield');
  assert.equal(m.decision, DECISION.MATCHED);
  assert.equal(m.teamId, 1);
  assert.equal(m.via, VIA.LITERAL);
});

// ─── a name is not a marker ───

test('a real name beginning with X, Y or Z keeps its first letter', () => {
  // The glued rule fires only on a LOWER-case marker followed by an UPPER-case
  // letter. "Zachary" is Z then a; nothing is stripped, so it cannot silently
  // become "Achary" and match somebody.
  for (const name of ['Zachary', 'Yusuf', 'Xavier']) {
    assert.equal(stripSortMarker(name), null, name);
    assert.equal(match(name).decision, DECISION.UNKNOWN, name);
  }
});

test('an ALL-CAPS glued label is refused rather than guessed at', () => {
  // "ZAARON" loses the case signal that says which letter is the marker.
  // Needs Review is the honest answer; eating the Z would be a guess.
  assert.equal(stripSortMarker('ZAARON'), null);
  assert.equal(match('ZAARON').decision, DECISION.UNKNOWN);
});

test('a genuine initial is not a sorting marker', () => {
  // Only x, y and z are markers. "J Smith" keeps its J, so a rule like "drop
  // any leading single letter" can never be slipped in here later.
  assert.equal(stripSortMarker('J Smith'), null);
  assert.equal(stripSortMarker('x Franky'), 'Franky');
});

test('a marker with nothing behind it is not a dispatcher', () => {
  assert.equal(stripSortMarker('x'), null);
  assert.equal(match('x').decision, DECISION.UNKNOWN);
});

// ─── several dispatchers on one row: unanimity, never majority ───

test('two dispatchers from DIFFERENT teams is AMBIGUOUS, never the first one', () => {
  const m = match('Franky/Steven');
  assert.equal(m.decision, DECISION.AMBIGUOUS);
  assert.equal(m.teamId, null);
  assert.deepEqual([...m.candidates].sort(), [2, 4]);
});

test('one known name and one unknown name is refused, not resolved to the known one', () => {
  // THE WRONG-TEAM FAILURE THIS WHOLE MODULE EXISTS TO PREVENT. "Nobody" may be
  // a real dispatcher on another team who has simply not been registered, so
  // placing the driver on Aaron's team is a guess with a payroll consequence.
  const m = match('Aaron/Nobody');
  assert.equal(m.decision, DECISION.UNKNOWN);
  assert.equal(m.teamId, null);
  assert.match(m.reason, /Nobody/);
});

test('an AMBIGUOUS name inside a list is reported as ambiguous, not as unknown', () => {
  // Both are Needs Review, but they are different jobs for the person reading
  // it: "two teams answer to Franky" is a naming collision to settle, "nobody
  // answers to Nobody" is a dispatcher to register. An earlier version of the
  // marker retry threw the ambiguous verdict away and reported the wrong one.
  const teams = [
    { id: 1, name: 'Aaron', memberNames: ['Jack Nunes'] },
    { id: 2, name: 'North', memberNames: ['Franky Alvarez'] },
    { id: 3, name: 'South', memberNames: ['Franky Bell'] },
  ];
  const m = matchDispatcherToTeam('Aaron/Franky', teams);
  assert.equal(m.decision, DECISION.AMBIGUOUS);
  assert.match(m.reason, /answers to more than one team/);
  assert.deepEqual([...m.candidates].sort(), [1, 2, 3]);
});

test('the separators dispatch actually uses all split the same way', () => {
  for (const label of ['Aaron/Jack', 'Aaron & Jack', 'Aaron, Jack', 'Aaron and Jack', 'Aaron + Jack']) {
    const m = match(label);
    assert.equal(m.decision, DECISION.MATCHED, label);
    assert.equal(m.teamId, 6, label);
  }
});

test('a single name is not a list — splitting reports that honestly', () => {
  assert.equal(splitDispatcherNames('Charles'), null);
  assert.equal(splitDispatcherNames('Charles Whitfield'), null,
    'two WORDS is not two NAMES; only a separator makes a list');
  assert.deepEqual(splitDispatcherNames('zAaron/Jack'), ['zAaron', 'Jack']);
});

test('a team genuinely named like a list is matched by its own name first', () => {
  // Pass 1 resolves the whole label as a full name before anything reads the
  // punctuation as a separator, so a team really called "Aaron/Jack" wins.
  const teams = [...TEAMS, { id: 7, name: 'Aaron/Jack', memberNames: [] }];
  const m = matchDispatcherToTeam('Aaron/Jack', teams);
  assert.equal(m.decision, DECISION.MATCHED);
  assert.equal(m.teamId, 7);
  assert.equal(m.via, VIA.LITERAL);
});

// ─── the safety property: a fallback can only rescue, never redirect ───

test('a label that already matched cannot be re-read by any fallback', () => {
  // A dispatcher genuinely called "Xavier Stone" on a team, and a marker-shaped
  // reading of the same string. The literal match must win outright.
  const teams = [{ id: 9, name: 'Ops', memberNames: ['Xavier Stone'] }, { id: 10, name: 'Stone', memberNames: [] }];
  const m = matchDispatcherToTeam('Xavier Stone', teams);
  assert.equal(m.decision, DECISION.MATCHED);
  assert.equal(m.teamId, 9, 'the literal full-name match, not the marker-stripped surname');
  assert.equal(m.via, VIA.LITERAL);
});

test('an AMBIGUOUS label is never rescued into a guess', () => {
  const teams = [
    { id: 11, name: 'North', memberNames: ['Franky Alvarez'] },
    { id: 12, name: 'South', memberNames: ['Franky Bell'] },
  ];
  const m = matchDispatcherToTeam('x Franky', teams);
  assert.equal(m.decision, DECISION.AMBIGUOUS,
    'stripping the marker finds two Frankys, and two is still a refusal');
  assert.equal(m.teamId, null);
});

test('an empty cell stays EMPTY — a different problem from an unknown name', () => {
  for (const label of ['', '   ', null, undefined]) {
    assert.equal(match(label).decision, DECISION.EMPTY, JSON.stringify(label));
  }
});
