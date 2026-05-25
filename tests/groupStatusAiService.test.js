const test = require('node:test');
const assert = require('node:assert/strict');

const updates = [];
const aiGroups = [
  { id: 1, group_name: 'UNIT A', active: true, status_source: 'bot' },
  { id: 2, group_name: 'UNIT B INACTIVE', active: true, status_source: 'ai' },
];

const db = {
  getDriverGroupsForStatusAi: async () => aiGroups.filter((g) => g.status_source !== 'manual'),
  updateGroupOperationalStatus: async (id, active, source) => {
    updates.push([id, active, source]);
    return { id, active, status_source: source };
  },
};

const classifyResults = new Map([
  [1, { active: true, reason: 'ok', provider: 'groq' }],
  [2, { active: false, reason: 'INACTIVE', provider: 'groq' }],
]);

require.cache[require.resolve('../database/db')] = { exports: db };
require.cache[require.resolve('../services/groupStatusAiClassifier')] = {
  exports: {
    classifyDriverGroups: async () => classifyResults,
  },
};

const { runClassificationRun } = require('../services/groupStatusAiService');

test('runClassificationRun skips manual-locked groups via getDriverGroupsForStatusAi', async () => {
  aiGroups[0].status_source = 'ai';
  aiGroups[0].active = true;
  aiGroups.push({
    id: 3,
    group_name: 'MANUAL LOCK',
    active: false,
    status_source: 'manual',
  });

  updates.length = 0;
  const result = await runClassificationRun();

  assert.equal(result.total, 2);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], [2, false, 'ai']);
  assert.ok(!updates.some((u) => u[0] === 3));

  aiGroups.pop();
  aiGroups[0].status_source = 'bot';
});

test('runClassificationRun does not update when ai status already matches', async () => {
  aiGroups[0].active = true;
  aiGroups[0].status_source = 'ai';
  aiGroups[1].active = false;
  aiGroups[1].status_source = 'ai';

  updates.length = 0;
  const result = await runClassificationRun();

  assert.equal(result.total, 2);
  assert.equal(updates.length, 0);

  aiGroups[0].status_source = 'bot';
  aiGroups[1].status_source = 'ai';
  aiGroups[1].active = true;
});
