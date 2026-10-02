'use strict';

/**
 * Follow a Telegram group to its new id — every place Wenze names it, in ONE
 * transaction, with one audit row.
 *
 * The list of places is lib/telegram/chatMigration.js. This module only
 * applies it, and refuses rather than guesses:
 *   - a column that does not exist on this database is skipped, not fatal;
 *   - the `groups` row moves only when no row already holds the new id (the
 *     UNIQUE id would refuse it anyway, and two rows for one chat is a person's
 *     decision);
 *   - undelivered notices are pointed at the new chat, and only those from the
 *     last REQUEUE_WITHIN_HOURS are put back in the queue.
 *
 * Idempotent: a second call for the same move changes nothing and reports so,
 * which matters because several notices fail on the same move at once.
 */
const { pool } = require('./pool');
const { insertAdminAudit } = require('./adminAudit');
const {
  DESTINATION_SETTINGS, DESTINATION_MAPS, REQUEUE_WITHIN_HOURS, normaliseChatId, rewriteChatMap,
} = require('../lib/telegram/chatMigration');

/** The queues whose undelivered rows still name a chat. */
const OUTBOXES = Object.freeze([
  { table: 'home_time_manager_notices', touchesUpdatedAt: false },
  { table: 'operational_notifications', touchesUpdatedAt: true },
]);

async function existingColumns(client, tables) {
  const res = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [tables]
  );
  return new Set(res.rows.map((r) => `${r.table_name}.${r.column_name}`));
}

async function moveSettings(client, have, from, to) {
  const changed = [];
  for (const s of DESTINATION_SETTINGS) {
    if (!have.has(`${s.table}.${s.column}`)) continue;
    // Table and column names come from the frozen list above, never input.
    // eslint-disable-next-line no-await-in-loop
    const res = await client.query(
      `UPDATE ${s.table} SET ${s.column} = $2::${s.type} WHERE ${s.column}::text = $1`,
      [from, to]
    );
    if (res.rowCount > 0) changed.push({ table: s.table, column: s.column, rows: res.rowCount });
  }
  for (const m of DESTINATION_MAPS) {
    if (!have.has(`${m.table}.${m.column}`)) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await client.query(`SELECT id, ${m.column} AS map FROM ${m.table} FOR UPDATE`);
    for (const row of res.rows) {
      const next = rewriteChatMap(row.map, from, to);
      if (next.changed === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      await client.query(`UPDATE ${m.table} SET ${m.column} = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(next.map)]);
      changed.push({ table: m.table, column: m.column, rows: next.changed });
    }
  }
  return changed;
}

async function moveGroupRow(client, have, from, to) {
  if (!have.has('groups.telegram_group_id')) return { moved: 0, conflict: false };
  const taken = await client.query('SELECT 1 FROM groups WHERE telegram_group_id::text = $1 LIMIT 1', [to]);
  if (taken.rowCount > 0) {
    const stillOld = await client.query('SELECT 1 FROM groups WHERE telegram_group_id::text = $1 LIMIT 1', [from]);
    return { moved: 0, conflict: stillOld.rowCount > 0 };
  }
  const res = await client.query(
    'UPDATE groups SET telegram_group_id = $2::bigint WHERE telegram_group_id::text = $1', [from, to]
  );
  return { moved: res.rowCount, conflict: false };
}

async function moveOutboxes(client, have, from, to) {
  let pointed = 0;
  let requeued = 0;
  for (const box of OUTBOXES) {
    if (!have.has(`${box.table}.chat_id`)) continue;
    const touch = box.touchesUpdatedAt ? ', updated_at = NOW()' : '';
    // eslint-disable-next-line no-await-in-loop
    const moved = await client.query(
      `UPDATE ${box.table} SET chat_id = $2${touch}
        WHERE chat_id = $1 AND state IN ('pending', 'failed')`,
      [from, to]
    );
    pointed += moved.rowCount;
    // eslint-disable-next-line no-await-in-loop
    const back = await client.query(
      `UPDATE ${box.table}
          SET state = 'pending', attempts = 0, next_attempt_at = NOW(),
              claimed_until = NULL, last_error = NULL${touch}
        WHERE chat_id = $1 AND state = 'failed'
          AND created_at > NOW() - ($2 || ' hours')::interval`,
      [to, String(REQUEUE_WITHIN_HOURS)]
    );
    requeued += back.rowCount;
  }
  return { pointed, requeued };
}

/**
 * @returns {Promise<{from, to, changed: Array, groupMoved: number,
 *   groupConflict: boolean, pointed: number, requeued: number, nothingToDo: boolean}>}
 */
async function followChatMigration(oldId, newId, { reason = null } = {}) {
  const from = normaliseChatId(oldId);
  const to = normaliseChatId(newId);
  if (!from || !to || from === to) {
    return { from, to, changed: [], groupMoved: 0, groupConflict: false, pointed: 0, requeued: 0, nothingToDo: true, invalid: true };
  }
  const tables = [...new Set([
    ...DESTINATION_SETTINGS.map((s) => s.table), ...DESTINATION_MAPS.map((m) => m.table),
    'groups', ...OUTBOXES.map((b) => b.table),
  ])];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const have = await existingColumns(client, tables);
    const changed = await moveSettings(client, have, from, to);
    const group = await moveGroupRow(client, have, from, to);
    const boxes = await moveOutboxes(client, have, from, to);
    const summary = {
      from, to, changed,
      groupMoved: group.moved, groupConflict: group.conflict,
      pointed: boxes.pointed, requeued: boxes.requeued,
    };
    summary.nothingToDo = changed.length === 0 && group.moved === 0 && boxes.pointed === 0;
    if (!summary.nothingToDo) {
      await insertAdminAudit({
        action: 'telegram.chat_migrated',
        entityType: 'telegram_chat',
        entityId: from,
        oldValues: { chatId: from },
        newValues: { chatId: to, changed, groupMoved: group.moved, pointed: boxes.pointed, requeued: boxes.requeued },
        reason: reason || 'Telegram reported the group was upgraded to a supergroup',
      }, client);
    }
    await client.query('COMMIT');
    return summary;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Every distinct chat id a destination setting currently names, so they can
 * be asked about BEFORE a send fails. Read-only; a missing column is skipped.
 */
async function listDestinationChatIds() {
  const tables = [...new Set([...DESTINATION_SETTINGS.map((s) => s.table), ...DESTINATION_MAPS.map((m) => m.table)])];
  const client = await pool.connect();
  try {
    const have = await existingColumns(client, tables);
    const ids = new Set();
    for (const s of DESTINATION_SETTINGS) {
      if (!have.has(`${s.table}.${s.column}`)) continue;
      // eslint-disable-next-line no-await-in-loop
      const res = await client.query(`SELECT DISTINCT ${s.column}::text AS id FROM ${s.table} WHERE ${s.column} IS NOT NULL`);
      for (const r of res.rows) { const id = normaliseChatId(r.id); if (id) ids.add(id); }
    }
    for (const m of DESTINATION_MAPS) {
      if (!have.has(`${m.table}.${m.column}`)) continue;
      // eslint-disable-next-line no-await-in-loop
      const res = await client.query(`SELECT ${m.column} AS map FROM ${m.table}`);
      for (const r of res.rows) {
        for (const v of Object.values(r.map || {})) { const id = normaliseChatId(v); if (id) ids.add(id); }
      }
    }
    return [...ids];
  } finally {
    client.release();
  }
}

module.exports = { followChatMigration, listDestinationChatIds, OUTBOXES };
