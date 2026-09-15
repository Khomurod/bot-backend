'use strict';

/**
 * Which dispatch team a board dispatcher belongs to, and what the roster should
 * be once that question is answered.
 *
 * THE LINE THESE TESTS DEFEND is the one the owner drew: harmless spelling
 * differences are handled, and anything that could put a driver on the WRONG
 * team is refused instead of guessed. "steve" is not Steven here, and it never
 * becomes Steven by adding a similarity threshold later — the test says so.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DECISION, MATCHED_ON, normaliseLabel, givenNameOf, matchDispatcherToTeam,
} = require('../lib/raise/dispatcherTeam');
const { OUTCOME, REVIEW_REASON, personKeyOf, planRoster } = require('../lib/raise/rosterPlan');

const TEAMS = [
  { id: 1, name: 'Charles', memberNames: ['Charles Whitfield'] },
  { id: 2, name: 'Steven', memberNames: ['Steven Ruiz'] },
  { id: 3, name: 'Team Charlotte', memberNames: ['Charlotte Diaz'] },
];

// ─── the dispatcher → team matcher ───

test('a board dispatcher maps a driver to the correct team', () => {
  const out = matchDispatcherToTeam('Charles', TEAMS);
  assert.equal(out.decision, DECISION.MATCHED);
  assert.equal(out.teamId, 1);
  assert.equal(out.matchedOn, MATCHED_ON.TEAM_NAME);
});

test('harmless naming variations are handled: prefixes, case, accents, punctuation', () => {
  for (const spelling of ['  charles ', 'CHARLES', 'Team Charles', 'Charles (dispatch)', 'Dispatcher Charles']) {
    const out = matchDispatcherToTeam(spelling, TEAMS);
    assert.equal(out.decision, DECISION.MATCHED, `${spelling} should match`);
    assert.equal(out.teamId, 1, `${spelling} should be team 1`);
  }
});

test("a dispatcher's full name reaches the team through its member list", () => {
  const out = matchDispatcherToTeam('CHARLES WHITFIELD', TEAMS);
  assert.equal(out.decision, DECISION.MATCHED);
  assert.equal(out.teamId, 1);
  assert.equal(out.matchedOn, MATCHED_ON.MEMBER_NAME);
});

test('an unknown dispatcher is UNKNOWN, never the nearest-looking team', () => {
  // The whole point: "steve" resembles "Steven" and must not become it.
  const out = matchDispatcherToTeam('steve', TEAMS);
  assert.equal(out.decision, DECISION.UNKNOWN);
  assert.equal(out.teamId, null);
});

test('a longer name that merely SHARES a prefix is not the same dispatcher', () => {
  const out = matchDispatcherToTeam('Charlotte', TEAMS);
  assert.equal(out.decision, DECISION.MATCHED);
  assert.equal(out.teamId, 3, 'Charlotte is her own team, not Charles');
});

test('two teams answering to one name is AMBIGUOUS, and names both candidates', () => {
  const out = matchDispatcherToTeam('Sam', [
    { id: 7, name: 'Sam', memberNames: [] },
    { id: 8, name: 'West', memberNames: ['Sam Porter'] },
  ]);
  assert.equal(out.decision, DECISION.AMBIGUOUS);
  assert.equal(out.teamId, null);
  assert.deepEqual([...out.candidates].sort(), [7, 8]);
});

test('an empty dispatcher cell is EMPTY — a different problem from an unknown one', () => {
  for (const blank of ['', '   ', null, undefined, '—']) {
    assert.equal(matchDispatcherToTeam(blank, TEAMS).decision, DECISION.EMPTY);
  }
});

test('normaliseLabel strips noise words only at the ends, never inside a name', () => {
  assert.equal(normaliseLabel('Team Charles'), 'CHARLES');
  assert.equal(normaliseLabel('Charles Dispatch'), 'CHARLES');
  assert.equal(normaliseLabel('José Núñez'), 'JOSE NUNEZ');
  assert.equal(givenNameOf('CHARLES WHITFIELD'), 'CHARLES');
});

test('a two-letter given name is not a key — "Jo" must not claim "Jo Ann"', () => {
  assert.equal(givenNameOf('JO ANN'), null);
});

// ─── the roster plan ───

const CHARLES_MATCH = { decision: DECISION.MATCHED, teamId: 1 };
const STEVEN_MATCH = { decision: DECISION.MATCHED, teamId: 2 };

function driver(over = {}) {
  return {
    personId: 10, driverProfileId: 100, groupId: 1000, unitNumber: '310',
    driverName: 'JOHN SMITH', driverNormalizedName: 'JOHN SMITH', ...over,
  };
}

test('permanent person identity is the key, ahead of the profile and the chat', () => {
  assert.equal(personKeyOf({ personId: 4, driverProfileId: 9, groupId: 2 }), 'person:4');
  assert.equal(personKeyOf({ driverProfileId: 9, groupId: 2 }), 'profile:9');
  assert.equal(personKeyOf({ groupId: 2 }), 'group:2');
  assert.equal(personKeyOf({ unitNumber: '310' }), null, 'a truck number is never an identity');
});

test('a driver the board moves to another dispatcher is moved, not left behind', () => {
  const { actions, summary } = planRoster({
    eligible: [driver()],
    current: [{ id: 1, teamId: 1, personId: 10, assignmentSource: 'board' }],
    boardByDriver: new Map([['person:10', { dispatcher: 'Steven', match: STEVEN_MATCH }]]),
  });
  assert.equal(summary.place, 1);
  assert.equal(actions[0].outcome, OUTCOME.PLACE);
  assert.equal(actions[0].teamId, 2);
  assert.equal(actions[0].fromTeamId, 1);
});

test('a driver already on the right team is a keep — running twice changes nothing', () => {
  const input = {
    eligible: [driver()],
    current: [{ id: 1, teamId: 1, personId: 10, assignmentSource: 'board' }],
    boardByDriver: new Map([['person:10', { dispatcher: 'Charles', match: CHARLES_MATCH }]]),
  };
  const first = planRoster(input);
  const second = planRoster(input);
  assert.equal(first.summary.keep, 1);
  assert.deepEqual(second.summary, first.summary);
});

test('an unknown or ambiguous dispatcher is Needs Review, and the driver is not placed', () => {
  for (const [decision, reason] of [
    [DECISION.UNKNOWN, REVIEW_REASON.UNKNOWN_DISPATCHER],
    [DECISION.AMBIGUOUS, REVIEW_REASON.AMBIGUOUS_DISPATCHER],
    [DECISION.EMPTY, REVIEW_REASON.NO_DISPATCHER],
  ]) {
    const { actions, summary } = planRoster({
      eligible: [driver()],
      current: [],
      boardByDriver: new Map([['person:10', { dispatcher: 'x', match: { decision, teamId: null } }]]),
    });
    assert.equal(summary.review, 1);
    assert.equal(summary.place, 0, 'never placed on a guess');
    assert.equal(actions[0].reason, reason);
  }
});

test('a driver with no board row at all is Needs Review, and keeps their current team', () => {
  const { actions } = planRoster({
    eligible: [driver()],
    current: [{ id: 1, teamId: 1, personId: 10, assignmentSource: 'board' }],
    boardByDriver: new Map(),
  });
  assert.equal(actions[0].outcome, OUTCOME.REVIEW);
  assert.equal(actions[0].reason, REVIEW_REASON.NO_BOARD_ROW);
  assert.equal(actions[0].teamId, 1, 'left where they are rather than removed on silence');
});

test('a driver with no stable identity is refused rather than placed by name', () => {
  const { actions } = planRoster({
    eligible: [driver({ personId: null, driverProfileId: null, groupId: null })],
    current: [],
    boardByDriver: new Map(),
  });
  assert.equal(actions[0].reason, REVIEW_REASON.UNRESOLVED_IDENTITY);
});

test('a driver who is no longer eligible leaves the roster', () => {
  const { actions, summary } = planRoster({
    eligible: [],
    current: [{ id: 9, teamId: 1, personId: 10, assignmentSource: 'board' }],
    boardByDriver: new Map(),
  });
  assert.equal(summary.remove, 1);
  assert.equal(actions[0].existing.id, 9);
});

test('a human override outranks the board and is reported, never overwritten', () => {
  const { actions, summary } = planRoster({
    eligible: [driver()],
    current: [{ id: 1, teamId: 1, personId: 10, assignmentSource: 'manual' }],
    boardByDriver: new Map([['person:10', { dispatcher: 'Steven', match: STEVEN_MATCH }]]),
  });
  assert.equal(summary.overrideHeld, 1);
  assert.equal(summary.overrideDisagrees, 1, 'the disagreement is visible');
  assert.equal(actions[0].outcome, OUTCOME.OVERRIDE_HELD);
  assert.equal(actions[0].teamId, 1, 'the human’s team stands');
  assert.equal(actions[0].boardTeamId, 2);
});

test('a human override that agrees with the board reports no disagreement', () => {
  const { summary } = planRoster({
    eligible: [driver()],
    current: [{ id: 1, teamId: 1, personId: 10, assignmentSource: 'manual' }],
    boardByDriver: new Map([['person:10', { dispatcher: 'Charles', match: CHARLES_MATCH }]]),
  });
  assert.equal(summary.overrideDisagrees, 0);
});

test('a manual row for a driver who is no longer eligible is held, not removed', () => {
  const { actions, summary } = planRoster({
    eligible: [],
    current: [{ id: 3, teamId: 1, personId: 10, assignmentSource: 'manual' }],
    boardByDriver: new Map(),
  });
  assert.equal(summary.remove, 0);
  assert.equal(actions[0].outcome, OUTCOME.OVERRIDE_HELD);
  assert.equal(actions[0].stale, true);
});

test('the same person on a new truck keeps their place — the key is the person', () => {
  const { summary } = planRoster({
    eligible: [driver({ unitNumber: '9999', groupId: 4242 })],
    current: [{ id: 1, teamId: 1, personId: 10, groupId: 1000, assignmentSource: 'board' }],
    boardByDriver: new Map([['person:10', { dispatcher: 'Charles', match: CHARLES_MATCH }]]),
  });
  assert.equal(summary.keep, 1, 'a truck change is not a new driver');
  assert.equal(summary.remove, 0);
});
