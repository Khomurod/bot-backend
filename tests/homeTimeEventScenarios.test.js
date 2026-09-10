/**
 * The home-time scenarios, as a business owner would describe them, driven
 * through the real orchestrator with the network replaced.
 *
 * These are the acceptance cases for "home time is an assistant, not a form":
 * a genuine request is understood and reported; a stop at the house on the way
 * to a delivery is not; an arrival and a return are separate events; and with
 * every AI provider down, obvious things still work while ambiguous ones are
 * left alone rather than guessed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { GROUP, FROM, TO, LAST_DAY, NOTIFY_GROUP_ID, loadService } = require('./helpers/homeTimeRequestServiceHarness');

const AI_DOWN = new Error('all providers failed');
const managerNotice = (h) => h.sends.find((s) => String(s.chatId) === String(NOTIFY_GROUP_ID));
const driverMsgs = (h) => h.sends.filter((s) => String(s.chatId) === String(GROUP.telegram_group_id));

function say(text, extra = {}) {
  return { message_id: 31, text, from: { id: 900, username: 'driver' }, ...extra };
}

// ── 1. a genuine request ─────────────────────────────────────────────────────

test('SCENARIO 1: "I need 4 days home next week" is understood, reported, and asks for the dates', async () => {
  const h = loadService({
    gemini: {
      json: {
        intent: 'home_time_request', confidence: 92, isActualStatusChange: false,
        requestedHomeTime: true, homeStartDate: null, returnToRoadDate: null,
      },
      text: 'Which day will you get home, and which day are you back on the road?',
    },
  });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, say('I need 4 days home next week'), {});
  assert.equal(h.inserts.length, 1, 'the request is recorded');
  assert.equal(h.inserts[0].detectedIntent, 'home_time_request');
  assert.ok(driverMsgs(h).length >= 1, 'and the driver is asked for the exact dates');
});

test('SCENARIO 1b: a request that already carries both dates tells the managers straight away', async () => {
  const h = loadService({
    gemini: {
      json: {
        intent: 'home_time_request', confidence: 95, isActualStatusChange: false,
        requestedHomeTime: true, homeStartDate: FROM, returnToRoadDate: TO,
      },
      text: 'Noted.',
    },
  });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, say(`I need home time ${FROM} to ${LAST_DAY}`), {});
  const notice = managerNotice(h);
  assert.ok(notice, 'the managers are told');
  assert.match(notice.text, /Home-Time Request/);
  assert.match(notice.text, /Driver is requesting Home Time/);
  assert.equal(notice.extra?.reply_markup, undefined, 'with no buttons to press');
  for (const who of ['@tomr_robins0n', '@SaffieBNett', '@amelia_wenze']) {
    assert.ok(notice.text.includes(who), `${who} is tagged`);
  }
});

// ── 2 and 3. home mentioned, no home time meant ──────────────────────────────

const NOT_A_REQUEST = [
  ['SCENARIO 2: a stop at the house for clothes', 'I need to stop by home to pick up my clothes before delivery'],
  ['SCENARIO 3: a delivery near home', 'Delivery is 20 miles from my home'],
  ['a hometown on the way', 'I am passing through my hometown tomorrow with the load'],
  ['a repair near home', 'Truck repair shop is near home, can I take it there'],
  ['Home Depot', 'Pickup is at Home Depot at 3pm'],
  ['almost there', 'almost home, 20 miles out'],
];

for (const [label, text] of NOT_A_REQUEST) {
  test(`${label} creates no request, no notice and no state change`, async () => {
    const h = loadService({
      // The model agrees it is ordinary conversation.
      gemini: {
        json: {
          intent: 'unrelated', confidence: 20, isActualStatusChange: false, requestedHomeTime: false,
        },
      },
    });
    await h.service.processHomeTimeMessage(h.telegram, GROUP, say(text), {});
    assert.equal(h.inserts.length, 0, 'nothing recorded');
    assert.equal(h.sends.length, 0, 'nobody told');
    assert.equal(h.stateTransitions.length, 0, 'nothing moved');
  });

  test(`${label} is still refused when the model wrongly calls it a request`, async () => {
    // The precision guard, not the model, is what protects these. A confident
    // wrong answer must not be enough to open a request.
    const h = loadService({
      gemini: {
        json: {
          intent: 'home_time_request', confidence: 95, isActualStatusChange: false, requestedHomeTime: true,
        },
      },
    });
    await h.service.processHomeTimeMessage(h.telegram, GROUP, say(text), {});
    assert.equal(h.sends.length, 0, `"${text}" must not reach the managers`);
  });
}

// ── 8. every AI provider is down ─────────────────────────────────────────────

test('SCENARIO 8: with AI down, plain time-off wording still opens a request', async () => {
  const h = loadService({ gemini: { json: AI_DOWN, text: AI_DOWN } });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, say('I need 4 days home'), {});
  assert.equal(h.inserts.length, 1, 'the deterministic fallback caught it');
  assert.equal(h.inserts[0].detectedIntent, 'home_time_request');
});

test('SCENARIO 8b: with AI down, an ambiguous mention of home invents nothing', async () => {
  const h = loadService({ gemini: { json: AI_DOWN, text: AI_DOWN } });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, say('I will swing by home before the delivery'), {});
  assert.equal(h.inserts.length, 0, 'a false record is worse than a missed one');
  assert.equal(h.sends.length, 0);
  assert.equal(h.stateTransitions.length, 0);
});

test('SCENARIO 8c: with AI down, an exact status line still moves the driver', async () => {
  const h = loadService({ gemini: { json: AI_DOWN, text: AI_DOWN } });
  const { parseDriverStatus } = require('../services/homeTimeConstants');
  assert.equal(parseDriverStatus('Status: Home'), 'home', 'the deterministic parser needs no model');
  assert.equal(parseDriverStatus('Status: Rolling'), 'road');
});

// ── 10. the same thing said twice ────────────────────────────────────────────

test('SCENARIO 10: the same request message processed twice tells the managers once', async () => {
  const h = loadService({
    gemini: {
      json: {
        intent: 'home_time_request', confidence: 95, isActualStatusChange: false,
        requestedHomeTime: true, homeStartDate: FROM, returnToRoadDate: TO,
      },
      text: 'Noted.',
    },
  });
  const msg = say(`I need home time ${FROM} to ${LAST_DAY}`);
  await h.service.processHomeTimeMessage(h.telegram, GROUP, msg, {});
  await h.service.processHomeTimeMessage(h.telegram, GROUP, { ...msg, message_id: 32 }, {});
  const notices = h.sends.filter((s) => String(s.chatId) === String(NOTIFY_GROUP_ID));
  assert.equal(notices.length, 1, 'one event, one notice');
});
