/**
 * The policy watcher's data layer — sources, snapshots, findings, alerts.
 *
 * Deliberately thin. Every decision this feature makes lives in the pure
 * modules (`lib/ai/policyText`, `policyDiff`, `policySuspension`); this file
 * reads and writes and holds no opinion, which is what lets the interesting
 * parts be tested without a database.
 *
 * ONE SNAPSHOT PER SOURCE, OVERWRITTEN. Not a history: keeping every version of
 * six providers' terms pages forever would be a slowly growing pile of
 * third-party prose in a database that exists to track trucks. What is worth
 * keeping is the CURRENT text (to diff against) and the FINDINGS — and a
 * finding quotes the passage that moved, so the evidence for anything Wenze
 * acted on survives without archiving the rest.
 */
const { query } = require('./pool');

const CACHE_TTL_MS = 30_000;
let settingsCache = null;
let settingsCacheExpiresAt = 0;

function invalidatePolicyCache() {
  settingsCache = null;
  settingsCacheExpiresAt = 0;
}

const SETTINGS_DEFAULTS = {
  enabled: false,
  checkDays: 'mon,thu',
  notifyChatId: null,
  notifyEnabled: true,
  notifyMinSeverity: 'warning',
  autoSuspendEnabled: false,
  lastRunAt: null,
  lastRunSummary: null,
};

function mapSettings(row) {
  if (!row) return { ...SETTINGS_DEFAULTS };
  return {
    enabled: row.enabled,
    checkDays: row.check_days,
    notifyChatId: row.notify_chat_id,
    notifyEnabled: row.notify_enabled,
    notifyMinSeverity: row.notify_min_severity,
    autoSuspendEnabled: row.auto_suspend_enabled,
    lastRunAt: row.last_run_at,
    lastRunSummary: row.last_run_summary,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** Defaults on any failure: the watcher must never be the thing that breaks a boot. */
async function getWatcherSettings() {
  const now = Date.now();
  if (settingsCache && now < settingsCacheExpiresAt) return settingsCache;
  try {
    const res = await query('SELECT * FROM ai_policy_watcher_settings WHERE id = 1');
    settingsCache = mapSettings(res.rows[0]);
  } catch (err) {
    console.warn('[POLICY] Settings unavailable, using defaults:', err.message);
    settingsCache = { ...SETTINGS_DEFAULTS };
  }
  settingsCacheExpiresAt = now + CACHE_TTL_MS;
  return settingsCache;
}

async function updateWatcherSettings(patch = {}, updatedBy = null) {
  const sets = [];
  const values = [];
  let i = 1;
  const set = (column, value) => {
    if (value === undefined) return;
    sets.push(`${column} = $${i}`);
    values.push(value);
    i += 1;
  };
  set('enabled', typeof patch.enabled === 'boolean' ? patch.enabled : undefined);
  set('notify_enabled', typeof patch.notifyEnabled === 'boolean' ? patch.notifyEnabled : undefined);
  set('auto_suspend_enabled',
    typeof patch.autoSuspendEnabled === 'boolean' ? patch.autoSuspendEnabled : undefined);
  if (patch.clearNotifyChatId) set('notify_chat_id', null);
  else set('notify_chat_id', patch.notifyChatId);
  if (['info', 'warning', 'serious'].includes(patch.notifyMinSeverity)) {
    set('notify_min_severity', patch.notifyMinSeverity);
  }
  if (typeof patch.checkDays === 'string' && patch.checkDays.trim()) {
    set('check_days', patch.checkDays.trim());
  }
  set('updated_by', updatedBy);
  sets.push('updated_at = NOW()');

  const res = await query(
    `UPDATE ai_policy_watcher_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    values
  );
  invalidatePolicyCache();
  return mapSettings(res.rows[0]);
}

async function recordRun(summary) {
  await query(
    'UPDATE ai_policy_watcher_settings SET last_run_at = NOW(), last_run_summary = $1::jsonb WHERE id = 1',
    [JSON.stringify(summary || {})]
  );
  invalidatePolicyCache();
}

// ─── sources ─────────────────────────────────────────────────────────────────

function mapSource(row) {
  if (!row) return null;
  return {
    id: row.id,
    providerKey: row.provider_key,
    url: row.url,
    kind: row.kind,
    sourceOrigin: row.source_origin ?? 'manual',
    redirectedTo: row.redirected_to ?? null,
    movedFrom: row.moved_from ?? null,
    rediscoveredAt: row.rediscovered_at ?? null,
    lostReportedAt: row.lost_reported_at ?? null,
    enabled: row.enabled,
    etag: row.etag ?? null,
    lastModified: row.last_modified ?? null,
    contentHash: row.content_hash ?? null,
    normalisedText: row.normalised_text ?? null,
    fetchedAt: row.fetched_at ?? null,
    httpStatus: row.http_status ?? null,
    lastError: row.last_error ?? null,
    consecutiveFailures: row.consecutive_failures ?? 0,
  };
}

/**
 * Every enabled source of every ENABLED provider, with its snapshot.
 *
 * Joined to `ai_providers` on purpose: a provider an operator has switched off
 * is one Wenze is not sending data to, so its terms are not currently Wenze's
 * problem and fetching them twice a week would be noise with a cost.
 */
async function listSourcesToCheck() {
  const res = await query(
    `SELECT s.*, sn.etag, sn.last_modified, sn.content_hash, sn.normalised_text,
            sn.fetched_at, sn.http_status, sn.last_error, sn.consecutive_failures
       FROM ai_policy_sources s
       JOIN ai_providers p ON p.provider_key = s.provider_key AND p.enabled = TRUE
       LEFT JOIN ai_policy_snapshots sn ON sn.source_id = s.id
      WHERE s.enabled = TRUE
      ORDER BY s.provider_key, s.id`
  );
  return res.rows.map(mapSource);
}

/** Everything, for the admin — including sources of disabled providers. */
async function listSourcesForAdmin() {
  const res = await query(
    `SELECT s.*, sn.content_hash, sn.fetched_at, sn.http_status, sn.last_error,
            sn.consecutive_failures
       FROM ai_policy_sources s
       LEFT JOIN ai_policy_snapshots sn ON sn.source_id = s.id
      ORDER BY s.provider_key, s.id`
  );
  return res.rows.map((row) => {
    const source = mapSource(row);
    delete source.normalisedText; // never needed in the admin, and it is large
    return source;
  });
}

/**
 * `sourceOrigin` says who chose the URL: 'manual' (a person), 'catalog' (seeded
 * from lib/ai/providerCatalog when the provider was connected) or
 * 'rediscovered' (found again after the original moved). A re-add of an
 * existing URL keeps the ORIGINAL origin — a catalogue seed must not relabel a
 * URL a person typed first, because the watcher treats the two differently.
 */
async function addSource({ providerKey, url, kind = 'terms', sourceOrigin = 'manual' }) {
  const res = await query(
    `INSERT INTO ai_policy_sources (provider_key, url, kind, source_origin)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider_key, url) DO UPDATE SET kind = EXCLUDED.kind, enabled = TRUE
     RETURNING *`,
    [providerKey, url, kind, sourceOrigin]
  );
  return mapSource(res.rows[0]);
}

/** The last fetch landed somewhere else. Recorded on every check, visible in the admin. */
async function recordRedirect(id, finalUrl) {
  await query('UPDATE ai_policy_sources SET redirected_to = $2 WHERE id = $1', [id, finalUrl || null]);
}

/**
 * The page has a new home. `url` is switched, the old one kept in `moved_from`
 * so the change is reviewable and reversible by hand; a loss is cleared, since
 * the page was just found. `origin` defaults to keeping whatever the row had.
 *
 * If the new URL is ALREADY watched for this provider (the catalogue and a
 * redirect can agree), the older duplicate is disabled rather than violating
 * the unique key, and the surviving row is returned.
 */
async function moveSource(id, newUrl, { origin = null } = {}) {
  const url = String(newUrl || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  const current = await query('SELECT * FROM ai_policy_sources WHERE id = $1', [id]);
  const row = current.rows[0];
  if (!row) return null;
  const clash = await query(
    'SELECT * FROM ai_policy_sources WHERE provider_key = $1 AND url = $2 AND id <> $3',
    [row.provider_key, url, id]
  );
  if (clash.rows[0]) {
    await query('UPDATE ai_policy_sources SET enabled = FALSE WHERE id = $1', [id]);
    await query(
      `UPDATE ai_policy_sources
          SET enabled = TRUE, rediscovered_at = NOW(), lost_reported_at = NULL, moved_from = $2
        WHERE id = $1`,
      [clash.rows[0].id, row.url]
    );
    return mapSource((await query('SELECT * FROM ai_policy_sources WHERE id = $1', [clash.rows[0].id])).rows[0]);
  }
  const res = await query(
    `UPDATE ai_policy_sources
        SET moved_from = url, url = $2, redirected_to = NULL, rediscovered_at = NOW(),
            lost_reported_at = NULL, enabled = TRUE,
            source_origin = COALESCE($3, source_origin)
      WHERE id = $1 RETURNING *`,
    [id, url, origin]
  );
  return mapSource(res.rows[0]);
}

/** A person has been told this page cannot be found. Once, until it is found again. */
async function markSourceLost(id) {
  await query('UPDATE ai_policy_sources SET lost_reported_at = NOW() WHERE id = $1', [id]);
}

async function clearSourceLost(id) {
  await query('UPDATE ai_policy_sources SET lost_reported_at = NULL, rediscovered_at = NOW() WHERE id = $1', [id]);
}

async function setSourceEnabled(id, enabled) {
  const res = await query(
    'UPDATE ai_policy_sources SET enabled = $2 WHERE id = $1 RETURNING *',
    [id, enabled === true]
  );
  return mapSource(res.rows[0]);
}

async function deleteSource(id) {
  const res = await query('DELETE FROM ai_policy_sources WHERE id = $1', [id]);
  return res.rowCount > 0;
}

/**
 * Record what a fetch found.
 *
 * `normalisedText` is written only when it is supplied — a 304 tells us the
 * page is unchanged and carries no body, so it refreshes the timestamps and
 * leaves the text alone.
 */
async function saveSnapshot(sourceId, {
  etag = null, lastModified = null, contentHash = null, normalisedText = null,
  httpStatus = null, error = null,
}) {
  await query(
    `INSERT INTO ai_policy_snapshots
       (source_id, etag, last_modified, content_hash, normalised_text,
        fetched_at, http_status, last_error, consecutive_failures, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, CASE WHEN $7::text IS NULL THEN 0 ELSE 1 END, NOW())
     ON CONFLICT (source_id) DO UPDATE
       SET etag = COALESCE(EXCLUDED.etag, ai_policy_snapshots.etag),
           last_modified = COALESCE(EXCLUDED.last_modified, ai_policy_snapshots.last_modified),
           content_hash = COALESCE(EXCLUDED.content_hash, ai_policy_snapshots.content_hash),
           normalised_text = COALESCE(EXCLUDED.normalised_text, ai_policy_snapshots.normalised_text),
           fetched_at = NOW(),
           http_status = EXCLUDED.http_status,
           last_error = EXCLUDED.last_error,
           consecutive_failures = CASE WHEN EXCLUDED.last_error IS NULL THEN 0
                                       ELSE ai_policy_snapshots.consecutive_failures + 1 END,
           updated_at = NOW()`,
    [sourceId, etag, lastModified, contentHash, normalisedText, httpStatus, error]
  );
}

module.exports = {
  SETTINGS_DEFAULTS,
  CACHE_TTL_MS,
  invalidatePolicyCache,
  mapSettings,
  getWatcherSettings,
  updateWatcherSettings,
  recordRun,
  mapSource,
  listSourcesToCheck,
  listSourcesForAdmin,
  addSource,
  recordRedirect,
  moveSource,
  markSourceLost,
  clearSourceLost,
  setSourceEnabled,
  deleteSource,
  saveSnapshot,
};
