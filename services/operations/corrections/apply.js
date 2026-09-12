/**
 * Applying and reverting a correction — one transaction, always audited.
 *
 * Each call does four things atomically, and the atomicity is the point: a
 * fleet row changed without its correction record, or a correction recorded
 * without its audit row, would leave the trail lying about what happened.
 *
 *   1. run the registered action (which re-checks its own precondition FOR UPDATE)
 *   2. write `operational_corrections` with the complete before and after images
 *   3. mirror it into `admin_audit_log` via `insertAdminAudit(entry, client)` —
 *      the SAME transaction, which is what that function's `client` argument was
 *      built for, and which brings its recursive secret redactor along for free
 *   4. mark the finding `applied`
 *
 * REVERT IS THE SAME PATH IN REVERSE, not a runbook note. It re-applies
 * `old_values` through the action's own `revert`, records itself as an audited
 * event, and stamps the original row. The trail is append-only: a reverted
 * correction still says it happened.
 */
const defaultDb = require('../../../database/pool');
const { insertAdminAudit } = require('../../../database/adminAudit');
const { getAction, StaleCorrectionError } = require('./actions');

/**
 * Who is doing this: 'system' for an auto-apply, 'admin:<id>' for somebody at
 * the admin panel, 'telegram:<id>' for an operator answering a question in the
 * notification group. Never a model.
 *
 * `telegram:<id>` IS A PERSON, and that is the whole point of the branch. The
 * schema refuses an approval-tier correction whose initiator is 'system'
 * (`operational_corrections_system_is_auto_only`), and without this a reply
 * from the owner would fall through to 'system' and be refused — the owner
 * would have answered a question Wenze then could not act on.
 */
function initiatorFor(admin) {
  if (admin && admin.id != null) return `admin:${admin.id}`;
  if (admin && admin.telegramUserId != null) return `telegram:${admin.telegramUserId}`;
  return 'system';
}

/**
 * Apply one correction.
 *
 * @param {object} args
 * @param {string} args.actionKey
 * @param {object} args.payload      what the action needs (from the finding's proposedChange)
 * @param {object} [args.finding]    the finding this answers
 * @param {object} [args.admin]      { id, username, roleKeys, ip } — absent = system
 * @param {string} [args.reason]
 * @param {object} [args.db]
 */
async function applyCorrection({
  actionKey, payload, finding = null, admin = null, reason = null, db = defaultDb,
}) {
  const action = getAction(actionKey);
  if (!action) throw new Error(`Unknown correction action: ${actionKey}`);

  const initiator = initiatorFor(admin);
  // The database enforces this too; failing here gives a better message than a
  // constraint violation would.
  if (initiator === 'system' && action.tier !== 'auto') {
    throw new Error(`${actionKey} is tier "${action.tier}" and cannot be applied by the system.`);
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const result = await action.apply(payload, client);

    const subjectId = String(
      payload.cycleId ?? payload.groupId ?? finding?.subjectId ?? ''
    );
    const inserted = await client.query(
      `INSERT INTO operational_corrections
         (finding_id, action_key, tier, subject_type, subject_id,
          old_values, new_values, affected_records, confidence, initiator, reason)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)
       RETURNING *`,
      [
        finding?.id ?? null,
        actionKey,
        action.tier,
        action.subjectType,
        subjectId,
        JSON.stringify(result.oldValues ?? {}),
        JSON.stringify(result.newValues ?? {}),
        JSON.stringify(result.affectedRecords ?? []),
        finding?.confidence ?? null,
        initiator,
        reason,
      ]
    );
    const correction = inserted.rows[0];

    await insertAdminAudit({
      adminId: admin?.id ?? null,
      roleKeys: admin?.roleKeys || [],
      action: `operational_correction.${actionKey}`,
      entityType: action.subjectType,
      entityId: subjectId,
      oldValues: result.oldValues,
      newValues: result.newValues,
      // THE AUDIT LOG MUST STILL SAY WHO. `admin_id` is null for a Telegram
      // operator — they have no admin account — so without naming the
      // initiator here, the one table a person opens to ask "who changed this"
      // would answer "nobody". The correction row carries it; so does this.
      reason: [
        reason || (finding ? `Finding #${finding.id}: ${finding.title}` : null),
        initiator.startsWith('telegram:') ? `(by ${initiator})` : null,
      ].filter(Boolean).join(' ') || null,
      ipAddress: admin?.ip ?? null,
    }, client);

    if (finding?.id) {
      await client.query(
        `UPDATE operational_findings
            SET status = 'applied', updated_at = NOW()
          WHERE id = $1 AND status = 'open'`,
        [finding.id]
      );
    }

    await client.query('COMMIT');
    return correction;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Undo a correction by re-applying its before-image.
 *
 * A revert is itself audited, and the original row is stamped rather than
 * deleted — "this was done, then undone" is the honest record, and "this never
 * happened" is not.
 */
async function revertCorrection({ correctionId, admin = null, reason = null, db = defaultDb }) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query(
      'SELECT * FROM operational_corrections WHERE id = $1 FOR UPDATE',
      [correctionId]
    );
    const correction = found.rows[0];
    if (!correction) throw new Error(`Correction ${correctionId} not found.`);
    if (correction.reverted_at) throw new Error(`Correction ${correctionId} is already reverted.`);

    const action = getAction(correction.action_key);
    if (!action) throw new Error(`Cannot revert: unknown action ${correction.action_key}`);

    await action.revert(correction, client);

    const revertedBy = admin?.username || initiatorFor(admin);
    const updated = await client.query(
      `UPDATE operational_corrections
          SET reverted_at = NOW(), reverted_by = $2, revert_reason = $3
        WHERE id = $1 AND reverted_at IS NULL
        RETURNING *`,
      [correctionId, revertedBy, reason]
    );
    if (!updated.rows[0]) throw new Error(`Correction ${correctionId} changed under us.`);

    await insertAdminAudit({
      adminId: admin?.id ?? null,
      roleKeys: admin?.roleKeys || [],
      action: `operational_correction.revert.${correction.action_key}`,
      entityType: correction.subject_type,
      entityId: correction.subject_id,
      // Reversed on purpose: the "new" state after a revert IS the old image.
      oldValues: correction.new_values,
      newValues: correction.old_values,
      reason,
      ipAddress: admin?.ip ?? null,
    }, client);

    // The condition is true again, so the finding is open again.
    if (correction.finding_id) {
      await client.query(
        `UPDATE operational_findings
            SET status = 'open', resolved_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'applied'`,
        [correction.finding_id]
      );
    }

    await client.query('COMMIT');
    return updated.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyCorrection, revertCorrection, StaleCorrectionError, initiatorFor };
