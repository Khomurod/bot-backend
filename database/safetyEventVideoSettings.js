/**
 * Safety-event video / music-overlay settings + music asset store.
 *
 * Backs Settings → Safety Event Music (admin panel). Two concerns:
 *
 *   1. safety_event_video_settings — a single-row (id = 1) config controlling
 *      the driver-group music overlay (enable flags, volume, fades, mixing).
 *   2. safety_event_music_assets   — uploaded music clips. Bytes live in Postgres
 *      BYTEA because the samsara-integration poller (a SEPARATE process using a
 *      DIFFERENT Telegram bot) must read them, and Telegram file_ids are
 *      bot-scoped. Exactly one asset is active at a time.
 *
 * None of these values are secrets, so — unlike the ELD/GMaps settings modules —
 * nothing is encrypted. Music bytes are NEVER returned to list/admin views; only
 * the dedicated download/active-fetch paths read `file_data`.
 */
const crypto = require('crypto');
const { query, pool } = require('./db');

const CACHE_TTL_MS = 30_000;
let cache = null;
let cacheExpiresAt = 0;

// Accepted audio types + size cap for uploads. Kept here so the route and the
// tests share one source of truth.
const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg', // mp3
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4', // m4a
  'audio/x-m4a',
  'audio/aac',
  'audio/aacp',
];
const MAX_MUSIC_BYTES = 20 * 1024 * 1024; // 20 MB — plenty for a short loop.

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
}

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function getSettingsRow() {
  try {
    const res = await query('SELECT * FROM safety_event_video_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    // Table may not exist yet on a brand-new DB before initializeDatabase ran.
    console.warn('[SAFETY VIDEO] safety_event_video_settings unavailable:', err.message);
    return null;
  }
}

/**
 * Effective config for server-side use (cached CACHE_TTL_MS). Safe defaults are
 * used when the row/table is missing so nothing breaks before setup.
 */
async function getSafetyEventVideoConfig() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;

  const row = await getSettingsRow();
  const effective = {
    driverGroupMusicEnabled: row ? row.driver_group_music_enabled === true : false,
    speedingMusicEnabled: row ? row.speeding_music_enabled !== false : true,
    activeMusicAssetId: row?.active_music_asset_id ?? null,
    samsaraNotificationGroupOriginalVideoEnabled:
      row ? row.samsara_notification_group_original_video_enabled !== false : true,
    musicVolume: numOr(row?.music_volume, 0.35),
    preserveOriginalAudio: row ? row.preserve_original_audio !== false : true,
    fadeInSeconds: numOr(row?.fade_in_seconds, 0),
    fadeOutSeconds: numOr(row?.fade_out_seconds, 1.5),
    loopMusicWhenVideoLonger: row ? row.loop_music_when_video_longer !== false : true,
    maxVideoSeconds: numOr(row?.max_video_seconds, 120),
    updatedAt: row?.updated_at || null,
  };

  cache = effective;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return effective;
}

function mapAssetMeta(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    mimeType: row.mime_type,
    fileSizeBytes: Number(row.file_size_bytes),
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    storageKind: row.storage_kind,
    storagePath: row.storage_path || null,
    checksumSha256: row.checksum_sha256 || null,
    isActive: row.is_active === true,
    uploadedBy: row.uploaded_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** List assets (metadata only — never returns bytes). */
async function listMusicAssets() {
  try {
    const res = await query(
      `SELECT id, name, description, mime_type, file_size_bytes, duration_seconds,
              storage_kind, storage_path, checksum_sha256, is_active, uploaded_by,
              created_at, updated_at
         FROM safety_event_music_assets
        ORDER BY is_active DESC, created_at DESC`,
    );
    return res.rows.map(mapAssetMeta);
  } catch (err) {
    console.warn('[SAFETY VIDEO] listMusicAssets failed:', err.message);
    return [];
  }
}

/**
 * Fetch one asset. Pass { includeData: true } to also load the BYTEA bytes
 * (used only by the download route and the samsara overlay worker).
 */
async function getMusicAssetById(id, { includeData = false } = {}) {
  if (!id) return null;
  const cols = includeData ? '*' : `id, name, description, mime_type, file_size_bytes,
    duration_seconds, storage_kind, storage_path, checksum_sha256, is_active,
    uploaded_by, created_at, updated_at`;
  const res = await query(
    `SELECT ${cols} FROM safety_event_music_assets WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  const meta = mapAssetMeta(row);
  if (includeData) meta.data = row.file_data || null;
  return meta;
}

/** The currently-active asset, if any. */
async function getActiveMusicAsset({ includeData = false } = {}) {
  const cols = includeData ? '*' : `id, name, description, mime_type, file_size_bytes,
    duration_seconds, storage_kind, storage_path, checksum_sha256, is_active,
    uploaded_by, created_at, updated_at`;
  try {
    const res = await query(
      `SELECT ${cols} FROM safety_event_music_assets WHERE is_active = TRUE LIMIT 1`,
    );
    const row = res.rows[0];
    if (!row) return null;
    const meta = mapAssetMeta(row);
    if (includeData) meta.data = row.file_data || null;
    return meta;
  } catch (err) {
    console.warn('[SAFETY VIDEO] getActiveMusicAsset failed:', err.message);
    return null;
  }
}

/**
 * Insert a new music asset (stored as BYTEA). When `activate` is true it becomes
 * the sole active asset and the settings row points at it — all in one
 * transaction so the "one active" invariant never breaks.
 * @returns {Promise<object>} the inserted asset metadata (no bytes)
 */
async function insertMusicAsset({
  name,
  description = null,
  mimeType,
  data,
  durationSeconds = null,
  uploadedBy = null,
  activate = true,
}) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new Error('music data buffer is required');
  }
  const checksum = crypto.createHash('sha256').update(data).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (activate) {
      // Clear any existing active asset first so the partial-unique index allows
      // the new one to be inserted active.
      await client.query('UPDATE safety_event_music_assets SET is_active = FALSE, updated_at = NOW() WHERE is_active = TRUE');
    }
    const ins = await client.query(
      `INSERT INTO safety_event_music_assets
         (name, description, mime_type, file_size_bytes, duration_seconds,
          storage_kind, file_data, checksum_sha256, is_active, uploaded_by,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'db_bytea',$6,$7,$8,$9,NOW(),NOW())
       RETURNING id`,
      [
        String(name || 'music'),
        description,
        String(mimeType || 'application/octet-stream'),
        data.length,
        durationSeconds,
        data,
        checksum,
        Boolean(activate),
        uploadedBy,
      ],
    );
    const newId = ins.rows[0].id;
    if (activate) {
      await client.query(
        'UPDATE safety_event_video_settings SET active_music_asset_id = $1, updated_at = NOW() WHERE id = 1',
        [newId],
      );
    }
    await client.query('COMMIT');
    invalidateCache();
    return getMusicAssetById(newId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Make one asset the active one (deactivating any other), in a transaction. */
async function setActiveMusicAsset(id) {
  if (!id) throw new Error('asset id is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT id FROM safety_event_music_assets WHERE id = $1', [id]);
    if (exists.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('UPDATE safety_event_music_assets SET is_active = FALSE, updated_at = NOW() WHERE is_active = TRUE AND id <> $1', [id]);
    await client.query('UPDATE safety_event_music_assets SET is_active = TRUE, updated_at = NOW() WHERE id = $1', [id]);
    await client.query('UPDATE safety_event_video_settings SET active_music_asset_id = $1, updated_at = NOW() WHERE id = 1', [id]);
    await client.query('COMMIT');
    invalidateCache();
    return getMusicAssetById(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deactivate an asset WITHOUT deleting it (the safe default — "keep previous
 * uploads inactive rather than deleting immediately"). If it was the active one,
 * clears settings.active_music_asset_id too.
 */
async function deactivateMusicAsset(id) {
  if (!id) throw new Error('asset id is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE safety_event_music_assets SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [id]);
    await client.query('UPDATE safety_event_video_settings SET active_music_asset_id = NULL, updated_at = NOW() WHERE id = 1 AND active_music_asset_id = $1', [id]);
    await client.query('COMMIT');
    invalidateCache();
    return getMusicAssetById(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Hard-delete an asset and its bytes. Refuses to delete the active asset (must
 * be deactivated first) so we never silently lose the in-use music.
 */
async function deleteMusicAsset(id) {
  if (!id) throw new Error('asset id is required');
  const active = await query('SELECT is_active FROM safety_event_music_assets WHERE id = $1', [id]);
  if (active.rowCount === 0) return { deleted: false, reason: 'not_found' };
  if (active.rows[0].is_active === true) return { deleted: false, reason: 'is_active' };
  await query('DELETE FROM safety_event_music_assets WHERE id = $1', [id]);
  invalidateCache();
  return { deleted: true };
}

/** Admin view: settings + active-asset summary + full asset list (no bytes). */
async function getSafetyEventVideoSettingsForAdmin() {
  const cfg = await getSafetyEventVideoConfig();
  const [assets, active] = await Promise.all([listMusicAssets(), getActiveMusicAsset()]);
  return {
    settings: {
      driverGroupMusicEnabled: cfg.driverGroupMusicEnabled,
      speedingMusicEnabled: cfg.speedingMusicEnabled,
      activeMusicAssetId: cfg.activeMusicAssetId,
      samsaraNotificationGroupOriginalVideoEnabled: cfg.samsaraNotificationGroupOriginalVideoEnabled,
      musicVolume: cfg.musicVolume,
      preserveOriginalAudio: cfg.preserveOriginalAudio,
      fadeInSeconds: cfg.fadeInSeconds,
      fadeOutSeconds: cfg.fadeOutSeconds,
      loopMusicWhenVideoLonger: cfg.loopMusicWhenVideoLonger,
      maxVideoSeconds: cfg.maxVideoSeconds,
      updatedAt: cfg.updatedAt,
    },
    activeMusic: active,
    musicAssets: assets,
  };
}

/** Update the single settings row via a dynamic SET builder (mirrors gmaps). */
async function updateSafetyEventVideoSettings(payload = {}) {
  const sets = [];
  const values = [];
  let i = 1;

  const pushBool = (column, value) => {
    if (typeof value === 'boolean') { sets.push(`${column} = $${i++}`); values.push(value); }
  };
  const pushNum = (column, value, { min, max } = {}) => {
    if (value === undefined || value === null || value === '') return;
    let n = Number(value);
    if (!Number.isFinite(n)) return;
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    sets.push(`${column} = $${i++}`); values.push(n);
  };

  pushBool('driver_group_music_enabled', payload.driverGroupMusicEnabled);
  pushBool('speeding_music_enabled', payload.speedingMusicEnabled);
  pushBool('samsara_notification_group_original_video_enabled', payload.samsaraNotificationGroupOriginalVideoEnabled);
  pushBool('preserve_original_audio', payload.preserveOriginalAudio);
  pushBool('loop_music_when_video_longer', payload.loopMusicWhenVideoLonger);
  pushNum('music_volume', payload.musicVolume, { min: 0, max: 2 });
  pushNum('fade_in_seconds', payload.fadeInSeconds, { min: 0, max: 60 });
  pushNum('fade_out_seconds', payload.fadeOutSeconds, { min: 0, max: 60 });
  pushNum('max_video_seconds', payload.maxVideoSeconds, { min: 0, max: 3600 });

  if (sets.length) {
    sets.push('updated_at = NOW()');
    await query(`UPDATE safety_event_video_settings SET ${sets.join(', ')} WHERE id = 1`, values);
    invalidateCache();
  }

  // Optional explicit active-asset change (null clears it).
  if (Object.prototype.hasOwnProperty.call(payload, 'activeMusicAssetId')) {
    const target = payload.activeMusicAssetId;
    if (target === null) {
      const active = await getActiveMusicAsset();
      if (active) await deactivateMusicAsset(active.id);
    } else if (Number.isFinite(Number(target))) {
      await setActiveMusicAsset(Number(target));
    }
  }

  return getSafetyEventVideoSettingsForAdmin();
}

module.exports = {
  ALLOWED_AUDIO_MIME_TYPES,
  MAX_MUSIC_BYTES,
  getSafetyEventVideoConfig,
  getSafetyEventVideoSettingsForAdmin,
  updateSafetyEventVideoSettings,
  listMusicAssets,
  getMusicAssetById,
  getActiveMusicAsset,
  insertMusicAsset,
  setActiveMusicAsset,
  deactivateMusicAsset,
  deleteMusicAsset,
  invalidateCache,
};
