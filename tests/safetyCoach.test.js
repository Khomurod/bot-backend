/**
 * Coaching a driver about a habit.
 *
 * Two lines this file exists to hold:
 *
 *   AI NEVER DECIDES WHETHER A DRIVER IS COACHED, only how the sentence reads.
 *   The decision is arithmetic in a pure module with no model in it, so with
 *   every provider dead every driver who should be coached still is.
 *
 *   NOTHING HERE DECIDES ANYTHING ABOUT A PERSON'S JOB. No score, no ranking,
 *   no fine. A model that reaches for a consequence is rejected and the fixed
 *   sentence is sent instead.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const coach = require('../services/safety/coach');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const nowIso = new Date(NOW).toISOString();
const ago = (days) => new Date(NOW - days * 86400000).toISOString();
const ev = (behavior, days, extra = {}) => ({ behavior, occurredAt: ago(days), ...extra });

const DRIVER = {
  key: 'person:11', personId: 11, groupId: 7, telegramGroupId: -1007,
  driverName: 'JOHN DOE', unitNumber: '310',
  events: Array.from({ length: 4 }, (_, i) => ev('HarshBraking', i + 1, { gForce: 0.7 })),
};

function harness({
  aiText = null, aiThrows = false, aiEnabled = true, coaching = [], drivers = [DRIVER],
  driverSendFails = false,
} = {}) {
  const calls = { notified: [], sentToDriver: [], recorded: [], prompts: [] };
  const deps = {
    store: {
      async listDriversWithRecentEvents() { return drivers; },
      async listCoachingFor() { return coaching; },
      async recordCoaching(r) { calls.recorded.push(r); return r; },
    },
    groups: {},
    async isCapabilityEnabled() { return aiEnabled; },
    async runCapability(req) {
      calls.prompts.push(req);
      if (aiThrows) throw new Error('every provider is down');
      return { text: aiText };
    },
    async notify(n) { calls.notified.push(n); return { recorded: true, delivered: true }; },
    driverChannel: {
      async sendToDriverGroup(telegram, chatId, text, opts) {
        if (driverSendFails) return null;
        calls.sentToDriver.push({ chatId, text, opts });
        return { message_id: 55 };
      },
    },
    telegram: {},
  };
  return { deps, calls };
}

// ── AI decides the wording, never the decision ───────────────────────────────

test('with every provider down the driver is still coached, in a real sentence', async () => {
  const { deps, calls } = harness({ aiThrows: true });
  const summary = await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  assert.equal(summary.coached, 1);
  assert.equal(calls.sentToDriver.length, 1);
  const text = calls.sentToDriver[0].text;
  assert.match(text, /JOHN|John/, 'it greets them by name');
  assert.match(text, /4 harsh braking events/);
  assert.match(text, /leaving more room ahead/, 'and says the one thing to do');
  assert.equal(summary.aiAssisted, 0);
});

test('with the capability switched off the fallback is used without asking', async () => {
  const { deps, calls } = harness({ aiEnabled: false, aiText: 'a nicer sentence entirely' });
  await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  assert.equal(calls.prompts.length, 0, 'the switch is honoured before the call');
  assert.match(calls.sentToDriver[0].text, /harsh braking/);
});

test('a good model answer IS used', async () => {
  const good = 'Hi John, the truck logged a few hard stops this fortnight. '
    + 'Leaving a bit more room ahead should smooth them right out.';
  const { deps, calls } = harness({ aiText: good });
  const summary = await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  assert.equal(calls.sentToDriver[0].text, good);
  assert.equal(summary.aiAssisted, 1);
});

// ── the bright line ──────────────────────────────────────────────────────────

test('a model that reaches for a consequence is rejected outright', async () => {
  for (const bad of [
    'Hi John, you had 4 hard stops. Another one this month and there will be a written warning.',
    'Hi John, 4 hard stops this fortnight. This will affect your safety score and your pay.',
    'Hi John, 4 hard stops. Further incidents may lead to disciplinary action being taken.',
    'Hi John, four hard brakes. You have been written up for this before, please improve.',
  ]) {
    assert.notEqual(coach.validateCoachingText(bad), true, `should be refused: ${bad}`);
    const { deps, calls } = harness({ aiText: bad });
    // eslint-disable-next-line no-await-in-loop
    await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
    assert.notEqual(calls.sentToDriver[0].text, bad, 'a consequence must never reach a driver');
    assert.match(calls.sentToDriver[0].text, /worth leaving more room/);
  }
});

test('the prompt forbids consequences and forbids inventing detail', () => {
  const prompt = coach.buildPrompt({
    pattern: { behavior: 'harsh_braking', count: 4, windowDays: 14, coachingPoint: 'x' },
    firstName: 'John',
  });
  assert.match(prompt, /Do NOT mention discipline, pay, points, scores, fines, warnings, or their job/);
  assert.match(prompt, /Do NOT invent any detail/);
  assert.equal(prompt.includes('JOHN DOE'), false, 'only a first name leaves this process');
});

test('an empty or absurd model answer falls back', async () => {
  for (const bad of ['', 'ok', 'x'.repeat(500)]) {
    assert.notEqual(coach.validateCoachingText(bad), true);
  }
});

// ── one habit at a time ──────────────────────────────────────────────────────

test('a driver with three habits is coached about ONE — the commonest', async () => {
  const busy = {
    ...DRIVER,
    events: [
      ...Array.from({ length: 3 }, (_, i) => ev('HarshBraking', i + 1)),
      ...Array.from({ length: 5 }, (_, i) => ev('Speeding', i + 1)),
      ...Array.from({ length: 3 }, (_, i) => ev('HarshTurn', i + 1)),
    ],
  };
  const { deps, calls } = harness({ drivers: [busy], aiThrows: true });
  await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  assert.equal(calls.sentToDriver.length, 1,
    'a message listing three faults is a reprimand however warmly it is worded');
  assert.match(calls.sentToDriver[0].text, /speeding/);
});

test('a habit coached recently is not raised again', async () => {
  const { deps, calls } = harness({
    aiThrows: true, coaching: [{ behavior: 'harsh_braking', sentAt: ago(2) }],
  });
  const summary = await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  assert.equal(calls.sentToDriver.length, 0);
  assert.equal(summary.coached, 0);
});

// ── escalation goes to people, with the numbers ──────────────────────────────

test('a heavy pattern reaches safety management, with what justified it', async () => {
  const heavy = {
    ...DRIVER,
    events: Array.from({ length: 8 }, (_, i) => ev('Speeding', i % 13, { gForce: null })),
  };
  const { deps, calls } = harness({ drivers: [heavy], aiThrows: true });
  const summary = await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  assert.equal(summary.escalated, 1);
  const esc = calls.notified.find((n) => n.category === 'safety_escalation');
  assert.match(esc.title, /8 speeding events/);
  assert.match(esc.action, /no automatic action has been taken/,
    'a safety manager must never think the software already did something');
  assert.equal(esc.evidence.count, 8);
});

test('escalation follows the person, so a truck change does not reset it', async () => {
  const heavy = { ...DRIVER, events: Array.from({ length: 8 }, (_, i) => ev('Speeding', i % 13)) };
  const { deps, calls } = harness({ drivers: [heavy], aiThrows: true });
  await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  const esc = calls.notified.find((n) => n.category === 'safety_escalation');
  assert.equal(esc.subjectType, 'person');
  assert.equal(esc.subjectId, 11);
});

// ── delivery ─────────────────────────────────────────────────────────────────

test('the driver message goes through the ONE choke point, so silent mode applies', async () => {
  const { deps, calls } = harness({ aiThrows: true });
  await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  assert.equal(calls.sentToDriver[0].chatId, -1007);
  assert.equal(calls.sentToDriver[0].opts.reason, 'safety_coaching');
});

test('when the driver cannot be reached, the note goes to operations instead of nowhere', async () => {
  const { deps, calls } = harness({ aiThrows: true, driverSendFails: true });
  await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  assert.equal(calls.sentToDriver.length, 0);
  const note = calls.notified.find((n) => /Coaching note/.test(n.title));
  assert.ok(note, 'somebody still learns that this driver has a habit');
  assert.equal(calls.recorded[0].deliveredTo, 'operations');
});

test('driver messaging can be switched off entirely for a trial period', async () => {
  const { deps, calls } = harness({ aiThrows: true });
  await coach.runSafetyCoachPass({ now: NOW, deps, options: { messageDrivers: false } });
  assert.equal(calls.sentToDriver.length, 0);
  assert.ok(calls.notified.some((n) => /Coaching note/.test(n.title)));
});

test('what was said is recorded, so the next pass can see it', async () => {
  const { deps, calls } = harness({ aiThrows: true });
  await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  const r = calls.recorded[0];
  assert.equal(r.personId, 11);
  assert.equal(r.behavior, 'harsh_braking');
  assert.equal(r.eventCount, 4);
  assert.equal(r.deliveredTo, 'driver_group');
  assert.ok(r.message, 'and what the driver was actually told');
});

test('one driver that throws does not stop the pass', async () => {
  const { deps, calls } = harness({
    aiThrows: true, drivers: [{ ...DRIVER, key: 'bad', events: null }, DRIVER],
  });
  const summary = await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  assert.equal(summary.drivers, 2);
  assert.equal(calls.sentToDriver.length, 1);
});

/**
 * The router's parameter is `validate`. `services/groqClient.js` forwards its
 * own `validateResult` into it, and this file passed that name straight to
 * `runCapability`, where it was silently ignored: the consequence guard still
 * ran afterwards, so nothing unsafe could be sent, but a provider answering
 * with a forbidden word no longer cost that provider its turn — the chain
 * stopped and the fixed sentence shipped instead of the next provider's answer.
 */
test('the coaching validator reaches the router under the name the router reads', async () => {
  const { deps, calls } = harness({ aiText: 'Hi John, the truck logged 4 harsh braking events in the last 14 days. Nothing serious, just worth easing off a little earlier.' });
  await coach.runSafetyCoachPass({ now: NOW, deps, options: {} });
  const call = calls.prompts[0];
  assert.ok(call, 'a model was asked');
  assert.strictEqual(typeof call.validate, 'function', 'runCapability reads `validate`');
  assert.strictEqual(call.validateResult, undefined, '`validateResult` is groqClient\'s name, not the router\'s');
  // And it is the real guard, not a stub that says yes.
  assert.notStrictEqual(call.validate('You have a written warning on file for this.'), true);
});
