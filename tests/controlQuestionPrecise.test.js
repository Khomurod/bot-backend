'use strict';

/**
 * Every question Wenze asks names WHO it is about, BOTH sides of what
 * disagrees, and what Yes will DO — and never an id. The owner's complaint of
 * 5 November 2026: "There is one person in this driver's chat, but their
 * Telegram name does not look like the driver. Record it as theirs anyway?"
 * was asked without the Telegram name, so it could not be answered.
 *
 * One realistic finding per askable check, in the evidence shape its check
 * writes. A NEW ASKABLE CHECK WITHOUT A FIXTURE HERE FAILS, so a question
 * cannot ship without someone deciding what it must show.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { QUESTIONS, questionFor, detailsFor } = require('../lib/control/askable');
const { parseIntent } = require('../lib/control/intent');

const CHAT = 'WENZE UNIT # 777 MCLEAN LATRAVIA';

/** checkKey → { finding, shows: strings the question must contain, ids: strings it must not } */
const CASES = {
  'home_time.closable_open_cycle': {
    finding: {
      title: 't',
      evidence: {
        cycleId: 9001, groupId: 4401, groupName: CHAT, homeDays: 6,
        homeArrivedAt: '2026-10-20T10:00:00Z', observedReturnAt: '2026-10-26T09:00:00Z',
      },
    },
    shows: [CHAT, '2026-10-20', '2026-10-26', '6 day'],
  },
  'identity.status_disagreement': {
    finding: {
      title: 't',
      evidence: {
        groupId: 4401, groupName: CHAT, groupActive: false, profileStatus: 'active',
        driverName: 'LATRAVIA MCLEAN', unitNumber: '777',
      },
      proposedChange: { to: 'inactive' },
    },
    shows: ['LATRAVIA MCLEAN', 'Unit 777', 'chat says not working', 'profile says working', CHAT],
  },
  'identity.status_needs_decision': {
    finding: {
      title: 't',
      evidence: { groupId: 4401, groupName: CHAT, groupActive: true, profileStatus: 'inactive', driverName: 'LATRAVIA MCLEAN', unitNumber: '777' },
      proposedChange: { to: 'active' },
    },
    shows: ['LATRAVIA MCLEAN', 'chat says working', 'profile says not working'],
  },
  'home_time.exhausted_internal_alerts': {
    finding: { title: 't', evidence: { count: 4, oldestAt: '2026-10-01T00:00:00Z', requestIds: [55501, 55502], lastError: 'chat not found' } },
    shows: ['4 staff', '2026-10-01', 'chat not found'],
    ids: ['55501'],
  },
  'identity.group_without_person': {
    finding: { title: 't', evidence: { groupId: 4401, groupName: CHAT } },
    shows: [CHAT],
  },
  'identity.stale_unit_assignment': {
    finding: { title: 't', evidence: { groupId: 4401, groupName: CHAT, personId: 3301, profileUnit: '322', recordedUnit: '320' } },
    shows: [CHAT, 'unit 322', '320'],
  },
  'identity.unit_handover': {
    finding: {
      title: 't',
      evidence: { groupId: 4401, groupName: CHAT, unitNumber: '013', personId: 3301, holders: [{ personId: 3302, displayName: 'VERNET FELICIEN' }] },
    },
    shows: [CHAT, 'unit 013', 'VERNET FELICIEN'],
  },
  'identity.unit_fleet_behind_profile': {
    finding: {
      title: 't',
      evidence: { groupId: 4401, groupName: CHAT, personId: 3301, unitNumber: '121', profileFleet: 'company', recordedFleet: 'owner_operator' },
    },
    shows: [CHAT, 'unit 121', 'Company driver', 'Owner-operator'],
  },
  'identity.truck_from_board': {
    finding: {
      title: 't',
      evidence: {
        groupId: 4401, groupName: 'WENZE UNIT # 1 ROGER ALCIDE', personId: 3301, unitNumber: '1', boardTruck: '1 ROGER',
        boardDriver: 'Roger Alcide', profileFleet: 'owner_operator', profileOwner: null, boardFleet: 'owner_operator', boardOwner: 'ROGER',
      },
    },
    shows: ['WENZE UNIT # 1 ROGER ALCIDE', '1 ROGER', 'Roger Alcide', 'truck of ROGER'],
  },
  'home_time.clock_reset_on_group_change': {
    finding: {
      title: 't',
      evidence: {
        personId: 3301, displayName: 'LATRAVIA MCLEAN', fromGroupId: 4400, fromGroupName: 'OLD CHAT',
        fromStateSince: '2026-09-01T00:00:00Z', toGroupId: 4401, toGroupName: CHAT, toStateSince: '2026-10-15T00:00:00Z', lostDays: 44,
      },
    },
    shows: ['LATRAVIA MCLEAN', 'OLD CHAT', CHAT, '2026-09-01', '2026-10-15', '44 days'],
  },
  'identity.telegram_link': {
    finding: {
      title: 't',
      evidence: {
        groupId: 4401, groupName: CHAT, personId: 3301, driverName: 'LATRAVIA MCLEAN',
        candidates: [{ telegramUserId: '7051234567', firstName: 'Latravia', lastName: 'McLean', username: 'lmclean' }],
      },
    },
    shows: [CHAT, 'LATRAVIA MCLEAN', '"Latravia McLean"', '@lmclean'],
    ids: ['7051234567'],
  },
  'identity.telegram_member_unnamed': {
    finding: {
      title: 't',
      evidence: {
        groupId: 4401, groupName: CHAT, personId: 3301, driverName: 'LATRAVIA MCLEAN',
        candidates: [{ telegramUserId: '7051234567', firstName: 'Tasha', lastName: 'M', username: 'tasha_m' }],
      },
    },
    // THE SCREENSHOT'S QUESTION: the Telegram name is the whole point.
    shows: [CHAT, 'LATRAVIA MCLEAN', '"Tasha M"', '@tasha_m'],
    ids: ['7051234567'],
  },
  'home_time.road_bonus_review': {
    finding: {
      title: 't',
      evidence: {
        roadHistoryId: 9002, groupId: 4401, driverName: 'LATRAVIA MCLEAN', unitNumber: '777', daysOnRoad: 52,
        bonusUsd: 300, roadStartedAt: '2026-08-01T00:00:00Z', homeArrivedAt: '2026-09-22T00:00:00Z',
      },
    },
    shows: ['LATRAVIA MCLEAN', 'Unit 777', '$300', '52 days', '2026-08-01', '2026-09-22'],
  },
  'identity.non_driver_typed_as_driver': {
    finding: { title: 't', evidence: { groupId: 4401, groupName: 'Wenze Facebook Leads' } },
    shows: ['Wenze Facebook Leads', 'driver list'],
  },
  'home_time.returned_to_road': {
    finding: {
      title: 't',
      evidence: {
        driverName: 'LATRAVIA MCLEAN', groupName: CHAT, unitNumber: '777', homeSince: '2026-10-28T00:00:00Z',
        summary: 'a load is in transit and the truck has left the home area',
      },
      proposedChange: { groupId: 4401, returnToRoadAt: '2026-11-04T12:00:00Z' },
    },
    shows: ['LATRAVIA MCLEAN', 'Unit 777', '2026-10-28', 'load is in transit', '2026-11-04'],
  },
};

const IDS = ['4401', '4400', '3301', '3302', '9001', '9002'];

function rendered(checkKey) {
  const { finding } = CASES[checkKey];
  const q = questionFor({ checkKey, ...finding });
  assert.ok(q, `${checkKey} has wording`);
  return { q, text: [q.ask, ...q.lines, q.yes].filter(Boolean).join('\n') };
}

test('EVERY askable check has a case here — a new question cannot ship unexamined', () => {
  const missing = Object.keys(QUESTIONS).filter((k) => !CASES[k]);
  assert.deepEqual(missing, [], 'add a realistic finding and what its question must show');
});

for (const checkKey of Object.keys(CASES)) {
  test(`${checkKey}: names who, both values, and what Yes does — and no id`, () => {
    const { text, q } = rendered(checkKey);
    for (const must of CASES[checkKey].shows) {
      assert.ok(text.includes(must), `${checkKey} must show "${must}":\n${text}`);
    }
    for (const id of [...IDS, ...(CASES[checkKey].ids || [])]) {
      assert.ok(!text.includes(id), `${checkKey} leaks an id (${id}):\n${text}`);
    }
    assert.ok(q.yes, `${checkKey} says what pressing Yes does`);
    assert.doesNotMatch(q.ask, /\bthis driver\b(?!'s chat)/, `${checkKey} names the driver instead of "this driver"`);
  });
}

test("the owner's screenshot, asked again: the Telegram name is in the question", () => {
  const { q } = rendered('identity.telegram_member_unnamed');
  assert.equal(q.ask, 'Is "Tasha M" (@tasha_m) LATRAVIA MCLEAN\'s own Telegram account?');
  assert.equal(q.yes, 'Yes → I record "Tasha M" (@tasha_m) as LATRAVIA MCLEAN\'s account.');
});

test('asking back is understood, in the three languages, without a model', () => {
  const offered = [{ key: 'approve' }, { key: 'dismiss' }, { key: 'snooze' }];
  for (const text of [
    "tell me that person's telegram name, then i can tell if it is she or no",
    'who is it?', 'which account?', 'show me', 'more details please', 'no idea', "I don't know",
    'кто это?', 'покажи', 'не знаю', 'kim bu?', "ko'rsat",
  ]) {
    assert.equal(parseIntent(text, { offered }).intent, 'details', text);
  }
  // …and a real answer is still an answer.
  assert.equal(parseIntent('yes', { offered }).intent, 'approve');
  assert.equal(parseIntent('no, the name is wrong', { offered }).intent, 'dismiss');
  assert.equal(parseIntent('later', { offered }).intent, 'snooze');
});

test('the details reply is everything the question knows — still no id', () => {
  const finding = { checkKey: 'identity.telegram_member_unnamed', ...CASES['identity.telegram_member_unnamed'].finding };
  const lines = detailsFor(finding);
  const text = lines.join('\n');
  assert.ok(text.includes('"Tasha M" (@tasha_m)'));
  assert.ok(text.includes(CHAT));
  assert.match(lines[lines.length - 1], /^Yes → /);
  assert.ok(!text.includes('7051234567'));
  assert.equal(detailsFor({ checkKey: 'not.askable' }), null);
});

test('an account with no name and no @username is said to be exactly that', () => {
  const finding = {
    checkKey: 'identity.telegram_member_unnamed',
    title: 't',
    evidence: { groupName: CHAT, driverName: 'LATRAVIA MCLEAN', candidates: [{ telegramUserId: '1' }] },
  };
  assert.match(questionFor(finding).ask, /an account with no name and no @username/);
});
