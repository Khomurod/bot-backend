/**
 * Master-list authority against a real PostgreSQL.
 *
 * Proves the rules that only a real database can prove: the constraints, the
 * one-time backfill, the transaction boundaries, and that archive/merge
 * preserve every scrap of history.
 *
 * Requires TEST_DATABASE_URL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

/** A trailer straight into the table, bypassing the app's creation guard. */
async function seedTrailer(harness, unit, overrides = {}) {
  const columns = { source: 'admin_manual', master_status: 'active', master_source: 'admin_manual', ...overrides };
  const keys = Object.keys(columns);
  const res = await harness.query(
    `INSERT INTO trailers (unit_number, ${keys.join(', ')})
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [unit, ...keys.map((k) => columns[k])],
  );
  return res.rows[0];
}

async function seedAdmin(harness, username = 'reviewer') {
  const res = await harness.query(
    `INSERT INTO admins (username, password_hash) VALUES ($1, 'x') RETURNING id`,
    [username],
  );
  return res.rows[0].id;
}

// ─── schema + backfill ───

test('the master-list migration is idempotent and classifies legacy rows exactly once', {
  skip: skipWithoutPg(), timeout: 60000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);

  // A row exactly as it looked BEFORE master-list authority existed: a legacy
  // `source`, and the column defaults the ALTERs give an un-backfilled row.
  await harness.query(`INSERT INTO trailers (unit_number, source, master_status, master_source) VALUES
    ('T-MANUAL',   'admin_manual',      'active', 'legacy_review'),
    ('T-IMPORT',   'screenshot_import', 'active', 'legacy_review'),
    ('T-DETECTED', 'telegram_detected', 'active', 'legacy_review')`);

  // The next boot is what classifies them.
  await harness.applyDepartmentSchema();

  await t.test('legacy sources map onto master-list status', async () => {
    const rows = await harness.query(
      'SELECT unit_number, master_status, master_source, master_review_reason FROM trailers ORDER BY unit_number',
    );
    const by = Object.fromEntries(rows.rows.map((r) => [r.unit_number, r]));

    assert.equal(by['T-MANUAL'].master_source, 'admin_manual');
    assert.equal(by['T-MANUAL'].master_status, 'active');
    assert.equal(by['T-IMPORT'].master_source, 'approved_import');
    assert.equal(by['T-IMPORT'].master_status, 'active');
    // Never verified by a human, so it is NOT an official asset.
    assert.equal(by['T-DETECTED'].master_status, 'pending_master_review');
    assert.ok(by['T-DETECTED'].master_review_reason, 'the reviewer is told why it is here');
  });

  await t.test('re-running the whole migration changes nothing', async () => {
    const before = await harness.query('SELECT id, unit_number, master_status, master_source FROM trailers ORDER BY id');
    await harness.applyDepartmentSchema();
    await harness.applyDepartmentSchema();
    const after = await harness.query('SELECT id, unit_number, master_status, master_source FROM trailers ORDER BY id');
    assert.deepEqual(after.rows, before.rows, 'schema.sql runs on EVERY boot — it must be a no-op');
  });

  await t.test('a reviewer decision survives the next boot', async () => {
    // The backfill must never undo human review. This is the failure that would
    // silently re-hide a trailer someone had just verified.
    await harness.query(
      `UPDATE trailers SET master_status = 'active', master_verified_at = NOW()
        WHERE unit_number = 'T-DETECTED'`,
    );
    await harness.applyDepartmentSchema();
    const row = await harness.query(`SELECT master_status FROM trailers WHERE unit_number = 'T-DETECTED'`);
    assert.equal(row.rows[0].master_status, 'active', 'the Keep decision is not reverted');
  });

  await t.test('an archived trailer is not reclassified either', async () => {
    await harness.query(
      `INSERT INTO trailers (unit_number, source, master_status, master_source)
       VALUES ('T-DETECTED-2', 'telegram_detected', 'active', 'legacy_review')`,
    );
    await harness.applyDepartmentSchema(); // classifies it as pending
    await harness.query(
      `UPDATE trailers SET master_status = 'archived', active = FALSE, archived_at = NOW()
        WHERE unit_number = 'T-DETECTED-2'`,
    );
    await harness.applyDepartmentSchema();
    const row = await harness.query(`SELECT master_status FROM trailers WHERE unit_number = 'T-DETECTED-2'`);
    assert.equal(row.rows[0].master_status, 'archived');
  });
});

// ─── constraints ───

test('master-list constraints hold', { skip: skipWithoutPg(), timeout: 30000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);

  await t.test('an invalid master_status is rejected', async () => {
    await assert.rejects(
      () => harness.query(`INSERT INTO trailers (unit_number, master_status) VALUES ('T-BAD', 'nonsense')`),
      (error) => error.code === '23514',
    );
  });

  await t.test('a merged trailer must name its survivor', async () => {
    await assert.rejects(
      () => harness.query(`INSERT INTO trailers (unit_number, master_status) VALUES ('T-M', 'merged')`),
      (error) => error.code === '23514',
    );
  });

  await t.test('a trailer cannot be merged into itself', async () => {
    const trailer = await seedTrailer(harness, 'T-SELF');
    await assert.rejects(
      () => harness.query(
        `UPDATE trailers SET master_status = 'merged', merged_into_trailer_id = $1 WHERE id = $1`,
        [trailer.id],
      ),
      (error) => error.code === '23514',
    );
  });

  await t.test('one alias cannot point at two active trailers', async () => {
    const a = await seedTrailer(harness, 'T-A');
    const b = await seedTrailer(harness, 'T-B');
    await harness.query(
      `INSERT INTO trailer_aliases (alias_unit_number, trailer_id, alias_type) VALUES ('T-OLD', $1, 'merge')`,
      [a.id],
    );
    await assert.rejects(
      () => harness.query(
        `INSERT INTO trailer_aliases (alias_unit_number, trailer_id, alias_type) VALUES ('T-OLD', $1, 'merge')`,
        [b.id],
      ),
      (error) => error.code === '23505',
      'ambiguous resolution must be impossible',
    );
  });

  await t.test('a retired alias frees the value again', async () => {
    const b = await seedTrailer(harness, 'T-C');
    await harness.query(`UPDATE trailer_aliases SET active = FALSE WHERE alias_unit_number = 'T-OLD'`);
    await assert.doesNotReject(() => harness.query(
      `INSERT INTO trailer_aliases (alias_unit_number, trailer_id, alias_type) VALUES ('T-OLD', $1, 'merge')`,
      [b.id],
    ));
  });

  await t.test('the same Telegram message cannot queue a duplicate mention', async () => {
    const insert = `INSERT INTO trailer_unmatched_mentions
      (normalized_unit_number, telegram_group_id, telegram_message_id) VALUES ('T-999', '-100', 5)`;
    await harness.query(insert);
    await assert.rejects(() => harness.query(insert), (error) => error.code === '23505');
  });
});

// ─── resolution never creates ───

test('resolution identifies trailers and never creates them', { skip: skipWithoutPg(), timeout: 30000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerMasterList } = harness.loadDataLayer(['trailerMasterList']);
  const trailer = await seedTrailer(harness, 'T-100');

  await t.test('a known official trailer resolves', async () => {
    const result = await trailerMasterList.resolveTrailerByUnitOrAlias('t-100');
    assert.equal(result.trailer.id, trailer.id);
    assert.equal(result.official, true);
    assert.equal(result.matchedBy, 'unit_number');
  });

  await t.test('an unknown number resolves to nothing and adds no row', async () => {
    const before = await harness.query('SELECT COUNT(*)::int AS count FROM trailers');
    const result = await trailerMasterList.resolveTrailerByUnitOrAlias('T-NOPE');
    const after = await harness.query('SELECT COUNT(*)::int AS count FROM trailers');

    assert.equal(result.trailer, null);
    assert.equal(after.rows[0].count, before.rows[0].count, 'the master list is untouched');
  });

  await t.test('an alias resolves to its canonical trailer', async () => {
    await harness.query(
      `INSERT INTO trailer_aliases (alias_unit_number, trailer_id, alias_type) VALUES ('T-LEGACY', $1, 'historical')`,
      [trailer.id],
    );
    const result = await trailerMasterList.resolveTrailerByUnitOrAlias('t-legacy');
    assert.equal(result.trailer.id, trailer.id);
    assert.equal(result.matchedBy, 'alias');
  });

  await t.test('a pending-review trailer resolves but is not official', async () => {
    const pending = await seedTrailer(harness, 'T-PENDING', { master_status: 'pending_master_review' });
    const result = await trailerMasterList.resolveTrailerByUnitOrAlias('T-PENDING');
    assert.equal(result.trailer.id, pending.id, 'the message is still evidence about a real record');
    assert.equal(result.official, false, 'but it must not be treated as an asset');
  });

  await t.test('an unmatched mention is recorded instead of a trailer', async () => {
    const mention = await trailerMasterList.recordUnmatchedMention({
      unit_number: 't-unknown', telegram_group_id: '-100777', telegram_message_id: 42,
      message_text: 'Picked up trailer T-UNKNOWN', extracted_action: 'pickup',
    });
    assert.equal(mention.normalized_unit_number, 'T-UNKNOWN');
    assert.equal(mention.review_status, 'pending');
    const trailers = await harness.query(`SELECT id FROM trailers WHERE unit_number = 'T-UNKNOWN'`);
    assert.equal(trailers.rows.length, 0, 'no trailer was invented');
  });

  await t.test('re-processing the same message does not queue a duplicate', async () => {
    const evidence = {
      unit_number: 'T-UNKNOWN', telegram_group_id: '-100777', telegram_message_id: 42,
      message_text: 'Picked up trailer T-UNKNOWN',
    };
    const again = await trailerMasterList.recordUnmatchedMention(evidence);
    assert.ok(again, 'the existing mention is returned');
    const count = await harness.query(
      `SELECT COUNT(*)::int AS count FROM trailer_unmatched_mentions WHERE normalized_unit_number = 'T-UNKNOWN'`,
    );
    assert.equal(count.rows[0].count, 1);
  });
});

// ─── reconciliation, transactionally ───

/** A confirmed snapshot batch, ready to reconcile. */
async function confirmedBatch(harness, adminId) {
  const res = await harness.query(
    `INSERT INTO trailer_import_batches
       (status, import_kind, is_complete_snapshot, confirmed_at, confirmed_by_admin_id)
     VALUES ('staged', 'master_snapshot', TRUE, NOW(), $1) RETURNING *`,
    [adminId],
  );
  return res.rows[0];
}

test('reconciliation applies decisions atomically and preserves history', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerMasterList } = harness.loadDataLayer(['trailerMasterList']);
  const adminId = await seedAdmin(harness);
  const actor = { id: adminId, username: 'reviewer', role_keys: ['trailer_manager'] };

  await t.test('an unconfirmed snapshot cannot be reconciled', async () => {
    const unconfirmed = await harness.query(
      `INSERT INTO trailer_import_batches (status, import_kind, is_complete_snapshot)
       VALUES ('staged', 'master_snapshot', TRUE) RETURNING *`,
    );
    const trailer = await seedTrailer(harness, 'T-UNCONF');
    await assert.rejects(
      () => trailerMasterList.applyReconciliation(
        unconfirmed.rows[0].id,
        [{ decision: 'keep_verified', trailer_id: trailer.id, reason: 'still ours' }],
        { actor },
      ),
      /complete official trailer list/i,
      'confirming the list IS complete is what makes "missing" meaningful',
    );
  });

  await t.test('keep_verified restores a pending trailer to the official list', async () => {
    const batch = await confirmedBatch(harness, adminId);
    const trailer = await seedTrailer(harness, 'T-KEEP', { master_status: 'pending_master_review' });

    await trailerMasterList.applyReconciliation(
      batch.id,
      [{ decision: 'keep_verified', trailer_id: trailer.id, reason: 'Sold trailer still on our books' }],
      { actor },
    );

    const after = await harness.query('SELECT * FROM trailers WHERE id = $1', [trailer.id]);
    assert.equal(after.rows[0].master_status, 'active');
    assert.ok(after.rows[0].master_verified_at, 'the verification is timestamped');
    assert.equal(after.rows[0].master_verified_by_admin_id, adminId, 'and attributed');

    const log = await harness.query(
      `SELECT * FROM trailer_master_reconciliation_log WHERE trailer_id = $1`, [trailer.id],
    );
    assert.equal(log.rows[0].decision, 'keep_verified');
    assert.match(log.rows[0].reason, /Sold trailer/);
  });

  await t.test('keep_verified without a reason is refused', async () => {
    const batch = await confirmedBatch(harness, adminId);
    const trailer = await seedTrailer(harness, 'T-NOREASON', { master_status: 'pending_master_review' });
    await assert.rejects(
      () => trailerMasterList.applyReconciliation(batch.id, [{ decision: 'keep_verified', trailer_id: trailer.id }], { actor }),
      /requires a reason/i,
    );
  });

  await t.test('archive keeps every event and rental record', async () => {
    const batch = await confirmedBatch(harness, adminId);
    const trailer = await seedTrailer(harness, 'T-ARCHIVE', { master_status: 'pending_master_review' });
    const event = await harness.query(
      `INSERT INTO trailer_events (trailer_id, trailer_unit_number, event_type, event_time)
       VALUES ($1, 'T-ARCHIVE', 'pickup', NOW()) RETURNING id`,
      [trailer.id],
    );

    await trailerMasterList.applyReconciliation(
      batch.id,
      [{ decision: 'archive', trailer_id: trailer.id, reason: 'Sold in 2024' }],
      { actor },
    );

    const after = await harness.query('SELECT * FROM trailers WHERE id = $1', [trailer.id]);
    assert.equal(after.rows[0].master_status, 'archived');
    assert.equal(after.rows[0].active, false);
    assert.ok(after.rows[0].archived_at);
    assert.ok(after.rows[0].id, 'the row itself is never deleted — history hangs off this id');

    // The whole point of archiving instead of deleting.
    const events = await harness.query(
      'SELECT id, trailer_id FROM trailer_events WHERE id = $1', [event.rows[0].id],
    );
    assert.equal(events.rows.length, 1, 'the event survives');
    assert.equal(events.rows[0].trailer_id, trailer.id, 'still attached to the archived trailer');
  });

  await t.test('archive is blocked while a rental is open', async () => {
    const batch = await confirmedBatch(harness, adminId);
    const trailer = await seedTrailer(harness, 'T-RENTED', { physical_status: 'rented' });
    const company = await harness.query(
      `INSERT INTO trailer_renter_companies (legal_name, display_name) VALUES ('Acme', 'Acme') RETURNING id`,
    );
    await harness.query(
      `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate)
       VALUES ('RENT-X-1', $1, $2, 'active', NOW(), NOW() + INTERVAL '5 days', 100)`,
      [trailer.id, company.rows[0].id],
    );

    await assert.rejects(
      () => trailerMasterList.applyReconciliation(
        batch.id, [{ decision: 'archive', trailer_id: trailer.id, reason: 'gone' }], { actor },
      ),
      /still open/i,
      'the trailer is physically out with a customer',
    );

    const after = await harness.query('SELECT master_status FROM trailers WHERE id = $1', [trailer.id]);
    assert.equal(after.rows[0].master_status, 'active', 'and it stays on the list');
  });

  await t.test('correct_unit renames the trailer and aliases the old number', async () => {
    const batch = await confirmedBatch(harness, adminId);
    const trailer = await seedTrailer(harness, 'T-1OO', { master_status: 'pending_master_review' });

    await trailerMasterList.applyReconciliation(
      batch.id,
      [{ decision: 'correct_unit', trailer_id: trailer.id, new_unit_number: 'T-100', reason: 'OCR read O for 0' }],
      { actor },
    );

    const after = await harness.query('SELECT * FROM trailers WHERE id = $1', [trailer.id]);
    assert.equal(after.rows[0].unit_number, 'T-100');
    assert.equal(after.rows[0].id, trailer.id, 'the SAME row — all history follows it');

    const alias = await harness.query(`SELECT * FROM trailer_aliases WHERE alias_unit_number = 'T-1OO'`);
    assert.equal(alias.rows[0].trailer_id, trailer.id, 'the old number still resolves');
    assert.equal(alias.rows[0].alias_type, 'ocr_correction');
  });

  await t.test('correct_unit onto an existing number is refused', async () => {
    const batch = await confirmedBatch(harness, adminId);
    const trailer = await seedTrailer(harness, 'T-DUP-SRC', { master_status: 'pending_master_review' });
    await seedTrailer(harness, 'T-DUP-DST');
    await assert.rejects(
      () => trailerMasterList.applyReconciliation(
        batch.id,
        [{ decision: 'correct_unit', trailer_id: trailer.id, new_unit_number: 'T-DUP-DST', reason: 'typo' }],
        { actor },
      ),
      /Merge them instead/i,
    );
  });
});

test('merge moves all history to the survivor and keeps both identifiers resolving', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerMasterList } = harness.loadDataLayer(['trailerMasterList']);
  const adminId = await seedAdmin(harness);
  const actor = { id: adminId, username: 'reviewer', role_keys: ['trailer_manager'] };

  const winner = await seedTrailer(harness, 'T-WIN');
  const loser = await seedTrailer(harness, 'T-LOSE', { master_status: 'pending_master_review' });
  const company = await harness.query(
    `INSERT INTO trailer_renter_companies (legal_name, display_name) VALUES ('Acme', 'Acme') RETURNING id`,
  );
  // Closed history on the loser: it must survive the merge intact.
  await harness.query(
    `INSERT INTO trailer_rentals (agreement_number, trailer_id, company_id, status, daily_rate)
     VALUES ('RENT-OLD-1', $1, $2, 'closed', 100)`,
    [loser.id, company.rows[0].id],
  );
  await harness.query(
    `INSERT INTO trailer_current_status (trailer_id, unit_number, current_status)
     VALUES ($1, 'T-LOSE', 'dropped')`,
    [loser.id],
  );

  const batch = await confirmedBatch(harness, adminId);
  await trailerMasterList.applyReconciliation(
    batch.id,
    [{ decision: 'merge', trailer_id: loser.id, merge_into_trailer_id: winner.id, reason: 'Duplicate of T-WIN' }],
    { actor },
  );

  await t.test('the loser is marked merged, never deleted', async () => {
    const after = await harness.query('SELECT * FROM trailers WHERE id = $1', [loser.id]);
    assert.equal(after.rows.length, 1, 'the row survives as a historical alias');
    assert.equal(after.rows[0].master_status, 'merged');
    assert.equal(after.rows[0].merged_into_trailer_id, winner.id);
    assert.equal(after.rows[0].active, false);
  });

  await t.test('its rental history moved to the survivor', async () => {
    const rental = await harness.query(`SELECT trailer_id FROM trailer_rentals WHERE agreement_number = 'RENT-OLD-1'`);
    assert.equal(rental.rows[0].trailer_id, winner.id, 'history is reassigned, not orphaned');
  });

  await t.test("the loser's derived status snapshot is cleared", async () => {
    const status = await harness.query('SELECT * FROM trailer_current_status WHERE trailer_id = $1', [loser.id]);
    assert.equal(status.rows.length, 0, 'a merged shell has no current status; its events moved');
  });

  await t.test('the old unit number still resolves — to the survivor', async () => {
    const result = await trailerMasterList.resolveTrailerByUnitOrAlias('T-LOSE');
    assert.equal(result.trailer.id, winner.id);
    assert.equal(result.matchedBy, 'alias');
    assert.equal(result.official, true);
  });

  await t.test('the merge is permanently audited', async () => {
    const log = await harness.query(
      `SELECT * FROM trailer_master_reconciliation_log WHERE decision = 'merge' AND trailer_id = $1`,
      [loser.id],
    );
    assert.equal(log.rows[0].merged_into_trailer_id, winner.id);
    assert.equal(log.rows[0].previous_unit_number, 'T-LOSE');
    assert.match(log.rows[0].reason, /Duplicate/);
  });
});

test('a failed decision rolls back the whole reconciliation', { skip: skipWithoutPg(), timeout: 30000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { trailerMasterList } = harness.loadDataLayer(['trailerMasterList']);
  const adminId = await seedAdmin(harness);
  const actor = { id: adminId, username: 'reviewer', role_keys: ['trailer_manager'] };

  const good = await seedTrailer(harness, 'T-GOOD', { master_status: 'pending_master_review' });
  const batch = await confirmedBatch(harness, adminId);

  // The first decision is valid; the second names a trailer that does not exist.
  await assert.rejects(
    () => trailerMasterList.applyReconciliation(
      batch.id,
      [
        { decision: 'keep_verified', trailer_id: good.id, reason: 'still ours' },
        { decision: 'keep_verified', trailer_id: 999999, reason: 'does not exist' },
      ],
      { actor },
    ),
    /not found/i,
  );

  await t.test('the valid decision was rolled back too — no half-applied statuses', async () => {
    const after = await harness.query('SELECT master_status FROM trailers WHERE id = $1', [good.id]);
    assert.equal(after.rows[0].master_status, 'pending_master_review', 'unchanged');
  });

  await t.test('the staged import survives for another attempt', async () => {
    const after = await harness.query('SELECT status, reconciled_at FROM trailer_import_batches WHERE id = $1', [batch.id]);
    assert.equal(after.rows[0].status, 'staged');
    assert.equal(after.rows[0].reconciled_at, null);
  });

  await t.test('no reconciliation log entry was left behind', async () => {
    const log = await harness.query('SELECT * FROM trailer_master_reconciliation_log WHERE batch_id = $1', [batch.id]);
    assert.equal(log.rows.length, 0);
  });
});
