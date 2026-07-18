/**
 * Home quick-action permission visibility (blocker §13) and per-user onboarding
 * (blocker §12). Pure admin helpers — one assertion per common role proves the
 * UI never shows an action the role lacks, and that dismissal is per user.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const QA = path.resolve(__dirname, '../admin/src/pages/trailer/homeQuickActions.js');
const ONB = path.resolve(__dirname, '../admin/src/pages/trailer/homeOnboarding.js');

let qa; let onb;
test.before(async () => {
  qa = await import(pathToFileURL(QA).href);
  onb = await import(pathToFileURL(ONB).href);
});

const labels = (perms) => qa.visibleQuickActions(perms).map((a) => a.label);

test('agreement-manage alone does NOT reveal payment/return/pickup actions', () => {
  // The old broad-fallback bug showed every action to this role.
  assert.deepEqual(labels(['trailer_agreements.manage']), ['Start a rental']);
});

test('inspection manager sees only Confirm a pickup', () => {
  assert.deepEqual(labels(['trailer_inspections.manage']), ['Confirm a pickup']);
});

test('rental-close role sees only Return a trailer', () => {
  assert.deepEqual(labels(['trailer_rentals.close']), ['Return a trailer']);
});

test('payment recorder sees only Record a payment', () => {
  assert.deepEqual(labels(['trailer_payments.record']), ['Record a payment']);
});

test('a full administrator sees every quick action', () => {
  assert.equal(labels(['admin.full_access']).length, qa.QUICK_ACTIONS.length);
});

test('a combined role sees exactly its actions', () => {
  assert.deepEqual(
    labels(['trailer_agreements.manage', 'trailer_payments.record']).sort(),
    ['Record a payment', 'Start a rental'],
  );
});

test('no permissions → no quick actions', () => {
  assert.deepEqual(labels([]), []);
  assert.deepEqual(labels(undefined), []);
});

// ── §12 per-user onboarding ──

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test('onboarding dismissal is namespaced per user', () => {
  const s = memoryStorage();
  assert.equal(onb.isOnboardingDismissed(s, 7), false);
  onb.dismissOnboarding(s, 7);
  assert.equal(onb.isOnboardingDismissed(s, 7), true);
  // A different user on the same browser still sees the guide.
  assert.equal(onb.isOnboardingDismissed(s, 8), false);
});

test('the key includes the user id', () => {
  assert.equal(onb.onboardingKey(42), 'trailerHomeWelcomeDismissed:42');
  assert.notEqual(onb.onboardingKey(1), onb.onboardingKey(2));
});

test('the guide explains the five destinations, not just the wizard', () => {
  const titles = onb.GUIDE_STEPS.map((s) => s.title);
  assert.deepEqual(titles, ['Home', 'Starting a rental', 'Confirming pickup', 'Returning a trailer', 'Recording payment']);
  // Each step actually has explanatory copy.
  assert.ok(onb.GUIDE_STEPS.every((s) => s.body && s.body.length > 40));
});
