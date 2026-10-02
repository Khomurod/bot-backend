'use strict';

/**
 * What the morning summary counts as "waiting", against a real PostgreSQL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function finding(h, subjectId, { status = 'open', title = `finding ${subjectId}`, snoozedHours = null } = {}) {
  const res = await h.query(
    `INSERT INTO operational_findings
       (check_key, subject_type, subject_id, title, status, dismissed_by, dismiss_reason, snoozed_until)
     VALUES ('identity.stale_unit_assignment', 'group', $1, $2, $3,
             CASE WHEN $3 = 'dismissed' THEN 'admin:1' END,
             CASE WHEN $3 = 'dismissed' THEN 'not needed' END,
             CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() + ($4 || ' hours')::interval END)
     RETURNING id`,
    [String(subjectId), title, status, snoozedHours]
  );
  return res.rows[0].id;
}

let seq = 0;
const CHAT = '-100123';

async function question(h, findingId, {
  daysAgo = 1, state = 'delivered', answered = false, parentId = null, chatId = CHAT,
} = {}) {
  seq += 1;
  const res = await h.query(
    `INSERT INTO operational_notifications
       (notice_key, category, chat_id, routed_via, body, state, question_json, finding_id,
        parent_notice_id, answered_at, created_at)
     VALUES ($1, 'needs_attention', $7, 'default', 'q', $2,
             '{"offeredActions":[{"key":"dismiss"}]}'::jsonb, $3, $4,
             CASE WHEN $5 THEN NOW() END, NOW() - ($6 || ' days')::interval)
     RETURNING id`,
    [`needs_attention:control_question:${findingId}:r${seq}`, state, findingId, parentId,
      answered, String(daysAgo), chatId]
  );
  return res.rows[0].id;
}

test('waiting = first questions, delivered, unanswered, about something still open — once per finding',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });

    const oldest = await finding(h, 1, { title: 'the oldest' });
    await question(h, oldest, { daysAgo: 5 });
    await question(h, oldest, { daysAgo: 1 }); // re-asked: still ONE thing waiting

    const newer = await finding(h, 2, { title: 'the newer' });
    const root = await question(h, newer, { daysAgo: 2 });
    await question(h, newer, { daysAgo: 1, parentId: root }); // a "why?" follow-up

    const answered = await finding(h, 3);
    await question(h, answered, { answered: true });

    const fixed = await finding(h, 4, { status: 'dismissed' });
    await question(h, fixed);

    const undelivered = await finding(h, 5);
    await question(h, undelivered, { state: 'pending' });

    const snoozed = await finding(h, 6, { snoozedHours: 48 });
    await question(h, snoozed);

    // Asked in a chat the summary is NOT going to — e.g. before the
    // destination was changed. Its title must not reach the new group.
    const elsewhere = await finding(h, 7, { title: 'asked in the old chat' });
    await question(h, elsewhere, { daysAgo: 9, chatId: '-100999' });

    const { controlDigest } = h.loadDataLayer(['controlDigest']);
    const out = await controlDigest.listWaitingQuestions({ limit: 3, chatId: CHAT });
    assert.equal(out.total, 2);
    assert.deepEqual(out.oldest.map((q) => q.title), ['the oldest', 'the newer']);
    // The age is from the FIRST time it was asked.
    const firstAsked = new Date(out.oldest[0].askedAt);
    assert.ok(Date.now() - firstAsked.getTime() > 4.5 * 86400_000);
  });

test('the count covers everything waiting, beyond the few that are named',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
    for (let i = 1; i <= 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await question(h, await finding(h, 100 + i), { daysAgo: 10 - i });
    }
    const { controlDigest } = h.loadDataLayer(['controlDigest']);
    const out = await controlDigest.listWaitingQuestions({ limit: 3, chatId: CHAT });
    assert.equal(out.total, 5);
    assert.equal(out.oldest.length, 3);
  });

test('nothing waiting reads as zero, not as unreadable', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { controlDigest } = h.loadDataLayer(['controlDigest']);
  assert.deepEqual(await controlDigest.listWaitingQuestions({ chatId: CHAT }), { total: 0, oldest: [] });
});

test('no destination chat means no titles at all', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await question(h, await finding(h, 1));
  const { controlDigest } = h.loadDataLayer(['controlDigest']);
  assert.equal(await controlDigest.listWaitingQuestions({ limit: 3 }), null);
});
