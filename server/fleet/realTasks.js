/**
 * FleetView real-mode task persistence — fleet_tasks / fleet_task_comments /
 * fleet_task_activity in the shared Postgres (additive-only, fleet_* prefix).
 *
 * These are FleetView-OWNED operational records: the only tables real mode is
 * allowed to write. Nothing here touches main-app tables or external systems.
 */

'use strict';

const realDb = require('./realDb');

function rowToTask(r) {
  return {
    id: r.id, tenant_id: r.tenant_id, title: r.title, description: r.description || '',
    status: r.status, priority: r.priority, department_id: r.department_id,
    creator_id: r.creator_id, assignee_id: r.assignee_id,
    related_load_id: r.related_load_id, related_driver_id: r.related_driver_id,
    related_broker_id: r.related_broker_id, related_company_id: r.company_id,
    label_ids: Array.isArray(r.label_ids) ? r.label_ids : [],
    due_at: r.due_at, source: r.source, version: r.version,
    created_at: r.created_at, updated_at: r.updated_at,
    has_linked_conversation: false,
    // display enrichment (real mode has no synthetic user directory)
    assignee_name: r.assignee_id, creator_name: r.creator_id,
    driver_name: r.related_driver_id, broker_name: null, dispatcher_name: null,
    load_number: r.related_load_id, load_route: null, dropoff_address: null,
    eta_label: null, labels: [],
  };
}

async function list(tenantId) {
  const { rows } = await realDb.query(
    'SELECT * FROM fleet_tasks WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId],
  );
  return rows.map(rowToTask);
}

async function get(id, tenantId) {
  const { rows } = await realDb.query(
    'SELECT * FROM fleet_tasks WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
  return rows[0] ? rowToTask(rows[0]) : null;
}

async function create(tenantId, companyId, actorId, fields) {
  const id = realDb.newId('tsk');
  await realDb.query(
    `INSERT INTO fleet_tasks (id, tenant_id, company_id, title, description, status, priority,
       department_id, creator_id, assignee_id, related_load_id, related_driver_id, label_ids, due_at, source)
     VALUES ($1,$2,$3,$4,$5,'todo',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, tenantId, companyId, fields.title, fields.description || '', fields.priority,
      fields.department, actorId, fields.assignee_id || null, fields.related_load_id || null,
      fields.related_driver_id || null, JSON.stringify(fields.label_ids || []), fields.due_at || null,
      fields.source || 'manual'],
  );
  await activity(tenantId, id, 'created', actorId, 'Task created');
  return get(id, tenantId);
}

async function update(tenantId, id, patch) {
  await realDb.query(
    `UPDATE fleet_tasks SET status = COALESCE($3, status), priority = COALESCE($4, priority),
       assignee_id = COALESCE($5, assignee_id), version = version + 1, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId, patch.status || null, patch.priority || null,
      patch.assignee_id === undefined ? null : patch.assignee_id],
  );
  return get(id, tenantId);
}

async function addComment(tenantId, taskId, authorId, body) {
  const id = realDb.newId('cmt');
  await realDb.query(
    'INSERT INTO fleet_task_comments (id, tenant_id, task_id, body, author_id) VALUES ($1,$2,$3,$4,$5)',
    [id, tenantId, taskId, body, authorId],
  );
  return { id, tenant_id: tenantId, task_id: taskId, body, author_id: authorId, author_name: authorId, mentions: [], created_at: new Date().toISOString() };
}

async function listComments(tenantId, taskId) {
  const { rows } = await realDb.query(
    'SELECT * FROM fleet_task_comments WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at ASC',
    [tenantId, taskId],
  );
  return rows.map((c) => ({ ...c, author_name: c.author_id }));
}

async function activity(tenantId, taskId, type, actor, detail) {
  await realDb.query(
    'INSERT INTO fleet_task_activity (id, tenant_id, task_id, type, actor, detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [realDb.newId('act'), tenantId, taskId, type, actor, detail || null],
  );
}

async function listActivity(tenantId, taskId) {
  const { rows } = await realDb.query(
    'SELECT * FROM fleet_task_activity WHERE tenant_id = $1 AND task_id = $2 ORDER BY timestamp ASC',
    [tenantId, taskId],
  );
  return rows.map((a) => ({ ...a, actor_name: a.actor }));
}

module.exports = { list, get, create, update, addComment, listComments, activity, listActivity };
