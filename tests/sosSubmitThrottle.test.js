/**
 * The SOS submit throttle — sized for a WHOLE ROOM, not one person.
 *
 * /questions is unauthenticated, so POST /submissions carries a per-IP sliding
 * window. `trust proxy` is set (Render terminates TLS upstream), so the limiter
 * sees the real client address — and a company questionnaire is filled by
 * everyone on the SAME office Wi-Fi at the same time, which is one NAT address.
 *
 * A 40-person session against the real server had 29 people rejected with HTTP
 * 429 when the cap was 12. The cap is not what protects the box (a load test
 * measured ~4.5 ms of server CPU per submission); it exists to stop scripted
 * flooding. These tests pin both halves of that: a full room gets through, and
 * sustained abuse from one address still gets throttled.
 *
 * The limiter is module-level state, so every test here loads a FRESH router via
 * withServer() and uses its own X-Forwarded-For address.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./helpers/sosRouteHarness');

// ─────────────── the submit throttle sizes for a whole room ───────────────
// A company questionnaire is filled by everyone on one office Wi-Fi at once, and
// `trust proxy` means the limiter sees that single NAT address. The cap must
// therefore clear a 40-person session while still stopping a scripted flood.

test('a 40-person session from ONE office IP is never throttled', async () => {
  await withServer({}, async (base) => {
    const officeIp = '203.0.113.10';
    const statuses = await Promise.all(Array.from({ length: 40 }, () => fetch(`${base}/api/sos/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': officeIp },
      body: JSON.stringify({ fullName: 'Employee', department: 'hr', language: 'uz', contentVersion: 1, answers: [] }),
    }).then((r) => r.status)));
    assert.equal(statuses.filter((s) => s === 429).length, 0,
      'no employee in a 40-person room may be rejected as "too many attempts"');
    assert.equal(statuses.filter((s) => s === 201).length, 40);
  });
});

test('scripted flooding from one IP is still throttled', async () => {
  await withServer({}, async (base) => {
    const attackerIp = '198.51.100.66';
    const statuses = [];
    for (let i = 0; i < 75; i += 1) {
      const res = await fetch(`${base}/api/sos/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': attackerIp },
        body: JSON.stringify({ fullName: 'Flood', department: 'hr', language: 'uz', contentVersion: 1, answers: [] }),
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), 'the limiter must still engage on sustained abuse');
    const firstBlocked = statuses.indexOf(429);
    assert.ok(firstBlocked >= 40 && firstBlocked <= 61,
      `throttle should engage after the room-sized budget, not before (engaged at ${firstBlocked})`);
    assert.equal(statuses[statuses.length - 1], 429);
  });
});

test('the real and test flows keep independent budgets for the same IP', async () => {
  await withServer({}, async (base) => {
    const officeIp = '203.0.113.11';
    const post = (path) => fetch(`${base}${path}/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': officeIp },
      body: JSON.stringify({ fullName: 'Employee', department: 'hr', language: 'uz', contentVersion: 1, answers: [] }),
    }).then((r) => r.status);

    // Exhaust the TEST budget…
    for (let i = 0; i < 61; i += 1) await post('/api/sos/test');
    assert.equal(await post('/api/sos/test'), 429);
    // …the REAL questionnaire is untouched.
    assert.equal(await post('/api/sos'), 201);
  });
});
