const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasHomeTimeSignal,
  hasStrongHomeTimeSignal,
  hasExplicitTimeOffSignal,
  hasHomeErrandSignal,
  looksLikeTemporaryHomeStop,
  hasOperationalContextSignal,
  looksLikeOperationalContext,
  looksLikeFirstPersonStatus,
  HOME_TIME_SIGNAL_PATTERNS,
  HOME_TIME_STRONG_SIGNAL_PATTERNS,
  HOME_TIME_EXPLICIT_TIMEOFF_PATTERNS,
  HOME_TIME_GO_HOME_PATTERNS,
  HOME_TIME_WEAK_SIGNAL_PATTERNS,
} = require('../services/homeTimeSignals');
const constants = require('../services/homeTimeRequestConstants');

test('broad = strong ∪ weak (no pattern drift)', () => {
  assert.equal(
    HOME_TIME_SIGNAL_PATTERNS.length,
    HOME_TIME_STRONG_SIGNAL_PATTERNS.length + HOME_TIME_WEAK_SIGNAL_PATTERNS.length,
  );
});

test('strong = explicit ∪ go-home (no pattern drift)', () => {
  assert.equal(
    HOME_TIME_STRONG_SIGNAL_PATTERNS.length,
    HOME_TIME_EXPLICIT_TIMEOFF_PATTERNS.length + HOME_TIME_GO_HOME_PATTERNS.length,
  );
});

test('constants re-exports the same broad detector (back-compat)', () => {
  assert.equal(constants.hasHomeTimeSignal, hasHomeTimeSignal);
});

test('hasHomeTimeSignal keeps its broad behavior (unchanged contract)', () => {
  // Strong wording
  assert.equal(hasHomeTimeSignal('driver wants to go home next week'), true);
  assert.equal(hasHomeTimeSignal('Can he get some home time?'), true);
  assert.equal(hasHomeTimeSignal('he needs a few days off'), true);
  assert.equal(hasHomeTimeSignal('requesting PTO'), true);
  // Soft/weak wording still counts as a broad signal
  assert.equal(hasHomeTimeSignal('heading home for the night'), true);
  assert.equal(hasHomeTimeSignal('he wants to be at the house for a bit'), true);
  // Ordinary chatter never matches
  assert.equal(hasHomeTimeSignal('Rate confirmation issue on this load'), false);
  assert.equal(hasHomeTimeSignal('Where is the BOL?'), false);
  assert.equal(hasHomeTimeSignal(''), false);
  assert.equal(hasHomeTimeSignal(null), false);
});

test('hasStrongHomeTimeSignal fires ONLY on unambiguous time-off wording', () => {
  // Strong: explicit time-off / request wording
  assert.equal(hasStrongHomeTimeSignal('can he get home time from Jul 2 to Jul 8?'), true);
  assert.equal(hasStrongHomeTimeSignal('he needs a couple days off'), true);
  assert.equal(hasStrongHomeTimeSignal('requesting PTO'), true);
  assert.equal(hasStrongHomeTimeSignal('going on vacation next week'), true);
  assert.equal(hasStrongHomeTimeSignal('please send me home for a few days'), true);
  assert.equal(hasStrongHomeTimeSignal('driver wants to go home'), true);
  assert.equal(hasStrongHomeTimeSignal('home for a week starting Monday'), true);
});

test('hasStrongHomeTimeSignal does NOT fire on incidental / soft "home" mentions', () => {
  assert.equal(hasStrongHomeTimeSignal('almost home boss'), false);
  assert.equal(hasStrongHomeTimeSignal('heading home for the night'), false);
  assert.equal(hasStrongHomeTimeSignal('just got home to the yard'), false);
  assert.equal(hasStrongHomeTimeSignal('picking up parts at Home Depot'), false);
  assert.equal(hasStrongHomeTimeSignal('he is at the house'), false);
  assert.equal(hasStrongHomeTimeSignal('home 20 miles out'), false);
  assert.equal(hasStrongHomeTimeSignal('Rate confirmation issue on this load'), false);
  assert.equal(hasStrongHomeTimeSignal(''), false);
});

// ── hasExplicitTimeOffSignal: the strictest "cannot be an errand" subset ──

test('hasExplicitTimeOffSignal fires only on unambiguous time-off wording', () => {
  assert.equal(hasExplicitTimeOffSignal('can he get home time from Jul 2 to Jul 8?'), true);
  assert.equal(hasExplicitTimeOffSignal('he needs a couple days off'), true);
  assert.equal(hasExplicitTimeOffSignal('requesting PTO'), true);
  assert.equal(hasExplicitTimeOffSignal('going on vacation next week'), true);
  assert.equal(hasExplicitTimeOffSignal('please send me home for a few days'), true);
  assert.equal(hasExplicitTimeOffSignal('home for a week starting Monday'), true);
});

test('hasExplicitTimeOffSignal EXCLUDES the ambiguous "go home" verb', () => {
  // "wants to go home" is a STRONG signal but NOT explicit — it can be an errand.
  assert.equal(hasStrongHomeTimeSignal('driver wants to go home'), true);
  assert.equal(hasExplicitTimeOffSignal('driver wants to go home'), false);
  assert.equal(hasExplicitTimeOffSignal('he needs to go home to grab his stuff'), false);
  assert.equal(hasExplicitTimeOffSignal('swing by home'), false);
});

// ── hasHomeErrandSignal: the negative (brief-stop / errand) signal ──

test('hasHomeErrandSignal detects brief stops, pickups, drop-offs, hometown, overnight', () => {
  assert.equal(hasHomeErrandSignal('he needs to pass by his house to pick up his personal belongings'), true);
  assert.equal(hasHomeErrandSignal('swing by home for the night'), true);
  assert.equal(hasHomeErrandSignal('stop by the house to grab his clothes'), true);
  assert.equal(hasHomeErrandSignal('drop off the paperwork at home'), true);
  assert.equal(hasHomeErrandSignal('drop him off at home'), true);
  assert.equal(hasHomeErrandSignal('route takes him through his hometown'), true);
  assert.equal(hasHomeErrandSignal('passing through his home town'), true);
  assert.equal(hasHomeErrandSignal("he'll be home for the night, back out tomorrow"), true);
  assert.equal(hasHomeErrandSignal('needs to grab his documents from home'), true);
  assert.equal(hasHomeErrandSignal('pick up his medicine real quick'), true);
  assert.equal(hasHomeErrandSignal('get his laptop and charger from the house'), true);
  assert.equal(hasHomeErrandSignal('he has a dentist appointment near home'), true);
  assert.equal(hasHomeErrandSignal('needs an oil change close to the house'), true);
});

test('hasHomeErrandSignal does NOT fire on genuine time-off wording or ordinary chatter', () => {
  assert.equal(hasHomeErrandSignal('driver wants to go home next week'), false);
  assert.equal(hasHomeErrandSignal('requesting PTO'), false);
  assert.equal(hasHomeErrandSignal('can he get home time from Jul 2 to Jul 8?'), false);
  assert.equal(hasHomeErrandSignal('he wants a few days off'), false);
  assert.equal(hasHomeErrandSignal('he wants to be home to rest for a few days'), false);
  assert.equal(hasHomeErrandSignal('he wants to go home and spend time with his kids'), false);
  assert.equal(hasHomeErrandSignal('Rate confirmation issue on this load'), false);
  assert.equal(hasHomeErrandSignal(''), false);
  assert.equal(hasHomeErrandSignal(null), false);
});

// ── looksLikeTemporaryHomeStop: the decision helper ──

test('looksLikeTemporaryHomeStop flags errands with no genuine time-off evidence', () => {
  // The exact false-positive example from the spec.
  assert.equal(
    looksLikeTemporaryHomeStop('Please talk to the driver. He needs to pass by his house to pick up his personal belongings.'),
    true,
  );
  assert.equal(looksLikeTemporaryHomeStop('he needs to go home to grab his documents then keep driving'), true);
  assert.equal(looksLikeTemporaryHomeStop('swing by home for the night'), true);
});

test('looksLikeTemporaryHomeStop yields to explicit time-off wording or a known date', () => {
  // Explicit wording wins even when errand words are also present.
  assert.equal(looksLikeTemporaryHomeStop('he wants home time and to grab his belongings'), false);
  // A concrete date/window means it is a real request, not a quick errand.
  assert.equal(looksLikeTemporaryHomeStop('pick up his stuff at home', { hasDate: true }), false);
  // Genuine requests with no errand marker are never flagged.
  assert.equal(looksLikeTemporaryHomeStop('driver wants to go home next week'), false);
  assert.equal(looksLikeTemporaryHomeStop('requesting PTO for next week'), false);
});

// ── operational context (the negative signal for ordinary driver-group talk) ──

test('hasOperationalContextSignal detects repairs, loads, facilities, ETA', () => {
  const hits = [
    'the trailer needs a repair',
    'broke down on I-80',
    'need a new tire',
    'taking it to the mechanic',
    "700 ml yurmaydi bu trailer. Yo'lda fix qilsak bo'ladimi aka",
    'send me the rate con',
    'where is the BOL',
    'delivery is at 8am',
    'shipper says the load is not ready',
    'he is at the yard',
    'parked at the terminal',
    'what is your ETA',
    'appointment is tomorrow',
    'once he gets to the truck',
  ];
  for (const text of hits) {
    assert.strictEqual(hasOperationalContextSignal(text), true, text);
  }
});

test('hasOperationalContextSignal does NOT fire on plain home-time wording', () => {
  const misses = [
    'I need four days of home time starting August 2',
    "My home time after tomorrow and I'm going to stay for the whole week",
    'he is asking for a few days off',
    'can I get home time next month',
    'Status: Home',
    'Status: Ready',
  ];
  for (const text of misses) {
    assert.strictEqual(hasOperationalContextSignal(text), false, text);
  }
});

test('looksLikeOperationalContext yields to explicit time-off wording or a known date', () => {
  const mixed = 'After I deliver this load I need 4 days off';
  assert.strictEqual(hasOperationalContextSignal(mixed), true, 'operational words are present');
  assert.strictEqual(looksLikeOperationalContext(mixed), false, 'but explicit time off wins');

  const dated = 'dropping the trailer at the terminal, home Aug 2 back Aug 6';
  assert.strictEqual(looksLikeOperationalContext(dated), true, 'no explicit wording, no date passed');
  assert.strictEqual(looksLikeOperationalContext(dated, { hasDate: true }), false, 'a real date wins');
});

// ── first-person status detection ──

test('looksLikeFirstPersonStatus accepts the driver speaking about themselves', () => {
  const hits = [
    "I'm home",
    'I am home now',
    'im at the house',
    'I just got home',
    'men uydaman',
    "men yo'ldaman",
    'я дома',
    'приехал домой',
  ];
  for (const text of hits) {
    assert.strictEqual(looksLikeFirstPersonStatus(text), true, text);
  }
});

test('looksLikeFirstPersonStatus rejects third-person reports about the driver', () => {
  const misses = [
    'He is currently at home and will let us know once he gets to the truck',
    'he is home',
    'the driver is home now',
    'they are back on the road',
    'driver will let me know',
  ];
  for (const text of misses) {
    assert.strictEqual(looksLikeFirstPersonStatus(text), false, text);
  }
});

test('third-person wins even when a first-person fragment appears in the same message', () => {
  // "I" appears, but the message is a staff report ABOUT the driver.
  assert.strictEqual(
    looksLikeFirstPersonStatus("I spoke to him, he is home and will let us know"),
    false,
  );
});
