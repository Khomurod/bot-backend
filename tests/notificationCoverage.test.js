/**
 * Every category has a real sender, and every sender goes through the one door.
 *
 * THE FAILURE THIS GUARDS. Before the router existed, five features each picked
 * their own destination column, their own outbox and their own message shape —
 * and one of them had a chat id with the minus sign dropped, discarding 101
 * staff alerts for months. The fix was a single `notify()`, and the fix only
 * holds while nothing routes around it.
 *
 * Two ways that decays, and both are checked here by reading the source rather
 * than by trusting a convention:
 *
 *   A CATEGORY NOBODY SENDS. A key in the catalogue with no caller is a
 *   configuration row an administrator can set that will never carry anything —
 *   a feature that looks wired up and is not.
 *
 *   A FEATURE THAT SENDS AROUND THE DOOR. An operational service reaching for
 *   `bot.telegram.sendMessage` directly is the old pattern coming back, and it
 *   would be invisible until the day its hard-coded destination went stale.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CATEGORY_KEYS } = require('../lib/notifications/categories');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SERVICE_FILES = [...walk(path.join(ROOT, 'services')), ...walk(path.join(ROOT, 'server'))];
const SOURCE = SERVICE_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/**
 * Categories at a `notify()` call site.
 *
 * Scoped to a NOTICE rather than any `category:` field, because the word is
 * used by other domains — an AI policy finding has a `category` too, and
 * counting those would have this test asserting that `discontinuation` is a
 * Telegram destination.
 */
function sentCategories() {
  const sent = new Set();
  for (const file of SERVICE_FILES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/notify\s*\(\s*\{[\s\S]{0,400}?category:\s*['"`]([a-z_]+)['"`]/g)) {
      sent.add(m[1]);
    }
    // The self-healing announcer builds its notice a function earlier and hands
    // the whole object to notify; catch those the same way.
    for (const m of src.matchAll(/category:\s*['"`]([a-z_]+)['"`],[\s\S]{0,200}?title:/g)) {
      sent.add(m[1]);
    }
  }
  return sent;
}

test('EVERY CATEGORY HAS A SENDER — a row nobody can fill is a feature that is not wired up', () => {
  // This is not hypothetical. `load_lifecycle` was configurable in the admin
  // from the day it was written and NOTHING SENT IT: the load watch required
  // `notify` in its dependencies and never called it, so an administrator could
  // point "Load status" at a Telegram group that would never receive anything.
  const sent = sentCategories();
  const unused = CATEGORY_KEYS.filter((key) => !sent.has(key));
  assert.deepEqual(unused, [],
    'these categories are configurable in the admin and nothing sends them');
});

test('every category sent is one the catalogue knows', () => {
  for (const key of sentCategories()) {
    // The router refuses an unknown key at runtime and logs; this catches the
    // typo at the point it is introduced instead.
    assert.ok(CATEGORY_KEYS.includes(key), `"${key}" is sent but is not a known category`);
  }
});

test('NO OPERATIONAL SERVICE MESSAGES TELEGRAM DIRECTLY — that is the old pattern', () => {
  // The engines added in this phase. Each one had its own destination in an
  // earlier design, and each one now composes a notice and hands it over.
  const engines = [
    'services/operations/selfHealing.js',
    'services/operations/learningPass.js',
    'services/retention/watch.js',
    'services/loads/lifecycleWatch.js',
    'services/fuelStop/riskWatch.js',
    'services/safety/coach.js',
    'services/homeTime/returnToRoadWatch.js',
  ];
  for (const rel of engines) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const forbidden of ['sendMessage(', 'safeSend(', 'telegram.send', 'sendTelegram']) {
      assert.ok(!src.includes(forbidden),
        `${rel} reaches for ${forbidden} — every notice goes through notify()`);
    }
  }
});

test('an engine either notifies or files a finding — never neither', () => {
  // `returnToRoadWatch` deliberately only FILES: a driver who looks back on the
  // road is a correction to propose on the Needs Attention page, and the
  // manager notice for a confirmed return has its own audience and its own
  // outbox (`home_time_manager_notices`) that predates this router. Rerouting
  // that would change who hears about Home Time, which nobody asked for.
  const engines = [
    ['services/operations/selfHealing.js', 'notify'],
    ['services/operations/learningPass.js', 'notify'],
    ['services/retention/watch.js', 'notify'],
    ['services/loads/lifecycleWatch.js', 'notify'],
    ['services/fuelStop/riskWatch.js', 'notify'],
    ['services/safety/coach.js', 'notify'],
    ['services/homeTime/returnToRoadWatch.js', 'upsertFinding'],
  ];
  for (const [rel, expected] of engines) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(src.includes(expected),
      `${rel} neither notifies nor files anything — it would run and be silent`);
  }
});

test('the ICONS table covers every category, so none arrives unlabelled', () => {
  // eslint-disable-next-line global-require
  const send = fs.readFileSync(path.join(ROOT, 'services/notifications/send.js'), 'utf8');
  for (const key of CATEGORY_KEYS) {
    assert.ok(new RegExp(`${key}:\\s*'`).test(send), `${key} has no icon`);
  }
});

test('a discarded notice is COUNTED, so "nothing is configured" becomes a number', () => {
  const send = fs.readFileSync(path.join(ROOT, 'services/notifications/send.js'), 'utf8');
  assert.ok(send.includes("recordDiscard(category, 'no_destination')"));
  assert.ok(send.includes("recordDiscard(category, 'disabled')"));
  // And still not enqueued: a backlog delivered months later into a live staff
  // chat is what this repository decided against with 98 expired alerts.
  const noDestBlock = send.slice(send.indexOf('if (!chatId)'), send.indexOf('const body ='));
  assert.ok(!noDestBlock.includes('enqueueNotification'),
    'a notice with nowhere to go must not become a backlog');
});
