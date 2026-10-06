'use strict';

/** A road bonus held for a person becomes a question somebody can answer. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runRoadBonusChecks, CHECK_KEYS } = require('../services/operations/checks/roadBonus');
const { actionForCheck } = require('../services/operations/corrections/actions');
const { payloadFor } = require('../services/operations/corrections/autoApply');
const { questionFor } = require('../lib/control/askable');

const HELD = {
  id: 41, group_id: 7, driver_name: 'TEST DRIVER', unit_number: '310',
  days_on_road: 117, exceeded_weeks: 12, home_days: 2, bonus_usd: '1200.00',
  bonus_decision_reason: '117 days on the road is longer than 6 weeks',
};

test('a held bonus is an approval finding with the one action that releases it', () => {
  const [f] = runRoadBonusChecks({ roadBonusReviews: [HELD] });
  assert.ok(CHECK_KEYS.includes(f.checkKey));
  assert.equal(f.tier, 'approval', 'money is never paid without a person');
  assert.equal(f.subjectType, 'road_history');
  assert.equal(f.subjectId, '41');
  assert.match(f.title, /TEST DRIVER, Unit 310: \$1200 road bonus for 117 days/);
  const action = actionForCheck(f.checkKey);
  assert.equal(action.key, 'home_time.release_road_bonus');
  assert.equal(action.tier, 'approval');
  assert.deepEqual(payloadFor(f), { roadHistoryId: 41 });
});

test('the question reads like a person asking, and names the trip', () => {
  const [f] = runRoadBonusChecks({ roadBonusReviews: [HELD] });
  const q = questionFor(f);
  assert.ok(q, 'there is wording for it');
  assert.match(JSON.stringify(q), /117 days on the road, \$1200 bonus/);
});

test('nothing held, nothing filed', () => {
  assert.deepEqual(runRoadBonusChecks({ roadBonusReviews: [] }), []);
});

test('A READ THAT FAILED THROWS — an outage must not clear a held bonus off the screen', () => {
  assert.throws(() => runRoadBonusChecks({ roadBonusReviews: null }), /could not be read/);
});

test('the sweep runs it', () => {
  // eslint-disable-next-line global-require
  const src = require('node:fs').readFileSync(require.resolve('../services/operations/consistencyService.js'), 'utf8');
  assert.match(src, /name:\s*'roadBonus',\s*keys:\s*roadBonus\.CHECK_KEYS/);
});
