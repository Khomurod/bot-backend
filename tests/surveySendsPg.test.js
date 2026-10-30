/**
 * Surveys against a real PostgreSQL (migration 0089): the list says which
 * survey went out and how many drivers answered, and "open" is what the answer
 * handler and the sender read.
 *
 * Requires TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const tr = (field, en) => ['en', 'ru', 'uz'].map((language) => ({ language, [field]: `${en}-${language}` }));

async function setup(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { questions } = harness.loadDataLayer(['questions']);
  const q = await questions.createQuestion(tr('question_text', 'Q'), [
    { option_order: 1, translations: tr('option_text', 'Yes') },
    { option_order: 2, translations: tr('option_text', 'No') },
  ]);
  return { harness, questions, q };
}

test('a new survey lists as never sent with no answers; a send is remembered', { skip: skipWithoutPg(), timeout: 30000 }, async (t) => {
  const { questions, q } = await setup(t);
  let [row] = await questions.getAllQuestions();
  assert.equal(row.id, q.id);
  assert.equal(row.last_sent_at, null);
  assert.equal(row.last_sent_groups, null);
  assert.equal(row.response_count, 0);

  await questions.recordQuestionSent(q.id, 37);
  [row] = await questions.getAllQuestions();
  assert.ok(row.last_sent_at instanceof Date);
  assert.equal(row.last_sent_groups, 37);
});

test('the answer count is per survey, and open / closed / missing read true / false / null', { skip: skipWithoutPg(), timeout: 30000 }, async (t) => {
  const { harness, questions, q } = await setup(t);
  const other = await questions.createQuestion(tr('question_text', 'Other'), [
    { option_order: 1, translations: tr('option_text', 'A') },
    { option_order: 2, translations: tr('option_text', 'B') },
  ]);
  const { rows: [driver] } = await harness.query("INSERT INTO drivers (telegram_user_id, first_name) VALUES (5001, 'Test') RETURNING id");
  const { rows: [group] } = await harness.query("INSERT INTO groups (telegram_group_id, group_name) VALUES (-5001, 'Test group') RETURNING id");
  const full = await questions.getQuestionWithOptions(q.id);
  assert.ok(await questions.saveResponse(driver.id, group.id, q.id, full.options[0].id));

  const counts = Object.fromEntries((await questions.getAllQuestions()).map((r) => [r.id, r.response_count]));
  assert.deepEqual(counts, { [q.id]: 1, [other.id]: 0 });

  assert.equal(await questions.isQuestionOpen(q.id), true);
  await questions.deactivateQuestion(q.id);
  assert.equal(await questions.isQuestionOpen(q.id), false);
  assert.equal(await questions.isQuestionOpen(999999), null);
});

test('an answer is recorded only for an open survey and one of its own options', { skip: skipWithoutPg(), timeout: 30000 }, async (t) => {
  const { harness, questions, q } = await setup(t);
  const other = await questions.createQuestion(tr('question_text', 'Other'), [
    { option_order: 1, translations: tr('option_text', 'A') },
    { option_order: 2, translations: tr('option_text', 'B') },
  ]);
  const { rows: [driver] } = await harness.query("INSERT INTO drivers (telegram_user_id, first_name) VALUES (5002, 'Test') RETURNING id");
  const { rows: [second] } = await harness.query("INSERT INTO drivers (telegram_user_id, first_name) VALUES (5003, 'Test') RETURNING id");
  const { rows: [group] } = await harness.query("INSERT INTO groups (telegram_group_id, group_name) VALUES (-5002, 'Test group') RETURNING id");
  const mine = (await questions.getQuestionWithOptions(q.id)).options[0].id;
  const notMine = (await questions.getQuestionWithOptions(other.id)).options[0].id;

  assert.equal(await questions.saveResponse(driver.id, group.id, q.id, notMine), null, "another survey's option is refused");
  assert.ok(await questions.saveResponse(driver.id, group.id, q.id, mine), 'its own option is recorded');
  assert.equal(await questions.saveResponse(driver.id, group.id, q.id, mine), null, 'a second answer is refused');

  await questions.deactivateQuestion(q.id);
  assert.equal(await questions.saveResponse(second.id, group.id, q.id, mine), null, 'a closed survey takes no answer');
  const { rows } = await harness.query('SELECT driver_id, option_id FROM responses WHERE question_id = $1', [q.id]);
  assert.deepEqual(rows, [{ driver_id: driver.id, option_id: mine }]);
});
