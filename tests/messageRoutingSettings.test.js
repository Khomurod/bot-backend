const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const OLD_HARDCODED_BONUS_GROUP = '-5170359585'; // the removed default — must never appear
const OLD_HARDCODED_EMPLOYEE_GROUP = '-1003284808897';

/**
 * Load database/messageRoutingSettings with a mutable fake db + a controllable
 * config (env fallback), injected via require.cache.
 */
function loadModule({ row = {}, config = {} } = {}) {
  const modPath = path.resolve(__dirname, '../database/messageRoutingSettings.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  for (const p of [modPath, dbPath, configPath]) delete require.cache[p];

  const store = {
    mileage_bonus_group_id: null,
    road_bonus_group_id: null,
    dispatch_review_group_id: null,
    raise_results_group_id: null,
    updated_at: null,
    ...row,
  };

  require.cache[dbPath] = {
    exports: {
      async query(sql, values = []) {
        if (/UPDATE message_group_settings/.test(sql)) {
          for (const m of sql.matchAll(/(\w+_group_id) = \$(\d+)/g)) {
            store[m[1]] = values[Number(m[2]) - 1];
          }
          return { rows: [] };
        }
        if (/SELECT \* FROM message_group_settings/.test(sql)) {
          return { rows: [{ ...store }] };
        }
        return { rows: [] };
      },
    },
  };
  require.cache[configPath] = {
    exports: {
      mileageBonusGroupId: '',
      roadBonusGroupId: '',
      dispatchReviewGroupId: '',
      raiseResultsGroupId: '',
      ...config,
    },
  };

  return { mod: require(modPath), store };
}

test('DB value is the source of truth for each category', async () => {
  const { mod } = loadModule({
    row: {
      mileage_bonus_group_id: '-100111',
      road_bonus_group_id: '-100222',
      dispatch_review_group_id: '-100333',
      raise_results_group_id: '-100444',
    },
  });
  assert.equal(await mod.getGroupId('mileageBonus'), '-100111');
  assert.equal(await mod.getGroupId('roadBonus'), '-100222');
  assert.equal(await mod.getGroupId('dispatchReview'), '-100333');
  assert.equal(await mod.getGroupId('raiseResults'), '-100444');
});

test('env value is used only as a fallback when the DB value is empty', async () => {
  const { mod } = loadModule({
    row: { mileage_bonus_group_id: '-100999' },
    config: { mileageBonusGroupId: '-100ENV', roadBonusGroupId: '-200ENV' },
  });
  // DB wins for mileage; env fills road; dispatch is unset everywhere.
  assert.equal(await mod.getGroupId('mileageBonus'), '-100999');
  assert.equal(await mod.getGroupId('roadBonus'), '-200ENV');
  assert.equal(await mod.getGroupId('dispatchReview'), null);
});

test('no configured group ⇒ null (never an old hardcoded default)', async () => {
  const { mod } = loadModule(); // empty row, empty env
  for (const category of ['mileageBonus', 'roadBonus', 'dispatchReview', 'raiseResults']) {
    assert.equal(await mod.getGroupId(category), null);
  }
  // The removed hardcoded defaults must not leak through anywhere.
  const cfg = await mod.getMessageGroupConfig();
  const serialized = JSON.stringify(cfg);
  assert.doesNotMatch(serialized, new RegExp(OLD_HARDCODED_BONUS_GROUP));
  assert.doesNotMatch(serialized, new RegExp(OLD_HARDCODED_EMPLOYEE_GROUP));
});

test('missingGroupMessage returns the category-specific configuration error', () => {
  const { mod } = loadModule();
  assert.equal(mod.missingGroupMessage('mileageBonus'), 'Mileage bonus group ID is not configured.');
  assert.equal(mod.missingGroupMessage('roadBonus'), 'Extra Week bonus group ID is not configured.');
  assert.equal(mod.missingGroupMessage('dispatchReview'), 'Dispatch rate review group ID is not configured.');
  assert.equal(
    mod.missingGroupMessage('raiseResults'),
    'Driver raise results (accounting) group ID is not configured.'
  );
});

test('updating a group ID changes where future messages resolve to', async () => {
  const { mod } = loadModule();
  assert.equal(await mod.getGroupId('roadBonus'), null);

  await mod.updateMessageGroupSettings({ roadBonus: '-100555' });
  // updateMessageGroupSettings invalidates the cache, so the new value is live.
  assert.equal(await mod.getGroupId('roadBonus'), '-100555');

  // Clearing it (empty string) reverts to "not configured".
  await mod.updateMessageGroupSettings({ roadBonus: '' });
  assert.equal(await mod.getGroupId('roadBonus'), null);
});

test('admin view exposes plaintext IDs + configured/fromEnv flags', async () => {
  const { mod } = loadModule({
    row: { mileage_bonus_group_id: '-100111' },
    config: { roadBonusGroupId: '-200ENV' },
  });
  const view = await mod.getMessageGroupSettingsForAdmin();
  assert.equal(view.mileageBonus.groupId, '-100111');
  assert.equal(view.mileageBonus.fromEnv, false);
  assert.equal(view.mileageBonus.configured, true);
  assert.equal(view.roadBonus.groupId, '-200ENV');
  assert.equal(view.roadBonus.fromEnv, true);
  assert.equal(view.dispatchReview.configured, false);
  assert.equal(view.raiseResults.configured, false);
  assert.equal(view.raiseResults.groupId, '');
});

// ─── The two driver-raise destinations are INDEPENDENT settings ───
//
// The review REQUEST (dispatchReview) and the submitted RESULT (raiseResults)
// have different audiences. Neither may ever stand in for the other: not through
// a shared column, not through a shared env var, not through a code fallback.

test('dispatchReview and raiseResults are separate columns and separate env vars', async () => {
  const { mod, store } = loadModule({
    row: { dispatch_review_group_id: '-100DISPATCH' },
    config: { dispatchReviewGroupId: '-100DISPATCH_ENV', raiseResultsGroupId: '-100ACCT_ENV' },
  });
  assert.equal(await mod.getGroupId('dispatchReview'), '-100DISPATCH');
  // raiseResults has no DB value, so it falls back to ITS OWN env var — never to
  // the dispatch value from either the DB or DISPATCH_REVIEW_GROUP_CHAT_ID.
  assert.equal(await mod.getGroupId('raiseResults'), '-100ACCT_ENV');
  assert.equal(store.raise_results_group_id, null, 'the dispatch value was not copied');
});

test('a configured dispatch group is NOT a fallback for an unset results group', async () => {
  const { mod } = loadModule({ row: { dispatch_review_group_id: '-100DISPATCH' } });
  assert.equal(await mod.getGroupId('dispatchReview'), '-100DISPATCH');
  assert.equal(await mod.getGroupId('raiseResults'), null, 'not configured means not configured');

  const view = await mod.getMessageGroupSettingsForAdmin();
  assert.equal(view.dispatchReview.configured, true);
  assert.equal(view.raiseResults.configured, false);
  assert.equal(view.raiseResults.groupId, '', 'the admin field is empty, not pre-filled');
});

test('saving one raise destination never moves or clears the other', async () => {
  const { mod, store } = loadModule({ row: { dispatch_review_group_id: '-100DISPATCH' } });

  // Set only the accounting group: dispatch is untouched.
  await mod.updateMessageGroupSettings({ raiseResults: '-100ACCT' });
  assert.equal(store.dispatch_review_group_id, '-100DISPATCH');
  assert.equal(await mod.getGroupId('dispatchReview'), '-100DISPATCH');
  assert.equal(await mod.getGroupId('raiseResults'), '-100ACCT');

  // Repoint only the dispatch group: accounting is untouched.
  await mod.updateMessageGroupSettings({ dispatchReview: '-100NEWDISPATCH' });
  assert.equal(await mod.getGroupId('dispatchReview'), '-100NEWDISPATCH');
  assert.equal(await mod.getGroupId('raiseResults'), '-100ACCT');

  // Clearing one leaves the other configured.
  await mod.updateMessageGroupSettings({ raiseResults: '' });
  assert.equal(await mod.getGroupId('raiseResults'), null);
  assert.equal(await mod.getGroupId('dispatchReview'), '-100NEWDISPATCH');
});

test('an admin may deliberately point both raise destinations at the same group', async () => {
  const { mod } = loadModule();
  await mod.updateMessageGroupSettings({ dispatchReview: '-100SHARED', raiseResults: '-100SHARED' });
  assert.equal(await mod.getGroupId('dispatchReview'), '-100SHARED');
  assert.equal(await mod.getGroupId('raiseResults'), '-100SHARED');
  const view = await mod.getMessageGroupSettingsForAdmin();
  assert.equal(view.dispatchReview.configured, true);
  assert.equal(view.raiseResults.configured, true);
});

test('every category is routable, and an unknown one is rejected', async () => {
  const { mod } = loadModule();
  assert.deepEqual(mod.CATEGORIES, ['mileageBonus', 'roadBonus', 'dispatchReview', 'raiseResults']);
  for (const category of mod.CATEGORIES) {
    assert.doesNotThrow(() => mod.missingGroupMessage(category));
    await mod.getGroupId(category); // resolves (null), does not throw
  }
  await assert.rejects(() => mod.getGroupId('raiseResult'), /Unknown message group category/);
});
