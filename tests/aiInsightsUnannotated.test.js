/**
 * An unannotated message is not an INTENT.
 *
 * Once a gap in the annotator's answer is recorded as NULL rather than
 * fabricated as `no_signal`, two different pieces of code have to agree about
 * what to do with it — and they did not. `computeSenderStats` mapped a NULL to
 * `'no_signal'`; the baseline query in `detectAnomalies` grouped by `a.intent`
 * in SQL and stored PostgreSQL's NULL under the JavaScript key `"null"`. The
 * same message therefore landed in a different bucket in each distribution, and
 * a driver with a handful of omitted baseline annotations could show a large —
 * even maximal — Jensen-Shannon divergence with an identical underlying
 * distribution. False anomaly cards, from a change made to stop fabricating.
 *
 * The fix is not to normalise the two keys to match. It is to leave unannotated
 * messages OUT of both distributions: they carry no information about intent,
 * and letting "we never annotated this" compete as an intent category is the
 * same fabrication in a different place.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeSenderStats } = require('../services/aiInsights/senderStats');
const { intentDistribution, jsDivergence } = require('../services/aiInsights/detectors');

const msg = (over = {}) => ({
  intent: 'status_update', sentiment: 0, urgency: 0,
  is_acknowledgement: false, toxic: false, ...over,
});

test('an unannotated message is counted, not filed under an intent', () => {
  const stats = computeSenderStats({ messages: [
    msg({ intent: 'status_update' }),
    msg({ intent: null }),
    msg({ intent: undefined }),
  ] });
  assert.deepEqual(stats.intents, { status_update: 1 });
  assert.equal(stats.unannotated, 2, 'the count is kept — the distribution is over fewer messages');
});

test('an EXPLICIT no_signal is still an intent', () => {
  const stats = computeSenderStats({ messages: [msg({ intent: 'no_signal' }), msg({ intent: null })] });
  assert.deepEqual(stats.intents, { no_signal: 1 });
  assert.equal(stats.unannotated, 1);
});

test('identical distributions do not diverge because of a naming difference', () => {
  // The exact shape of the bug: the baseline carried NULLs under "null" and the
  // current window carried the same messages under "no_signal".
  const current = computeSenderStats({ messages: [
    msg({ intent: 'status_update' }), msg({ intent: 'status_update' }),
    msg({ intent: null }), msg({ intent: null }),
  ] });
  const baselineCounts = { status_update: 2 }; // NULLs excluded by the query

  assert.equal(
    jsDivergence(intentDistribution(current.intents), intentDistribution(baselineCounts)),
    0,
    'same underlying distribution, zero divergence'
  );
});
