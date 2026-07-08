const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// In-memory fake of database/db.js (query + pool.connect) backed by a small
// store, so the transactional music-asset logic and the settings SET-builder are
// exercised without a real Postgres. Mirrors the SQL emitted by the module.
function loadModule() {
  const modPath = path.resolve(__dirname, '../database/safetyEventVideoSettings.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  delete require.cache[modPath];
  delete require.cache[dbPath];

  const store = {
    seq: 0,
    settings: { id: 1, driver_group_music_enabled: false, speeding_music_enabled: true,
      active_music_asset_id: null, samsara_notification_group_original_video_enabled: true,
      music_volume: 0.35, preserve_original_audio: true, fade_in_seconds: 0, fade_out_seconds: 1.5,
      loop_music_when_video_longer: true, max_video_seconds: 120, updated_at: null },
    assets: [],
    lastUpdateSql: null,
  };

  function handle(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [], rowCount: 0 };

    if (/SELECT \* FROM safety_event_video_settings/i.test(s)) return { rows: [store.settings], rowCount: 1 };

    if (/UPDATE safety_event_video_settings SET/i.test(s)) {
      store.lastUpdateSql = { sql: s, params };
      for (const m of s.matchAll(/(\w+) = \$(\d+)/g)) store.settings[m[1]] = params[Number(m[2]) - 1];
      for (const m of s.matchAll(/(\w+) = NULL/g)) {
        // Only the conditional clears; honor "active_music_asset_id = NULL"
        if (m[1] !== 'id') store.settings[m[1]] = null;
      }
      return { rows: [], rowCount: 1 };
    }

    if (/SELECT is_active FROM safety_event_music_assets WHERE id = \$1/i.test(s)) {
      const a = store.assets.find((x) => x.id === params[0]);
      return { rows: a ? [{ is_active: a.is_active }] : [], rowCount: a ? 1 : 0 };
    }
    if (/FROM safety_event_music_assets WHERE id = \$1/i.test(s)) {
      const a = store.assets.find((x) => x.id === params[0]);
      return { rows: a ? [a] : [], rowCount: a ? 1 : 0 };
    }
    if (/FROM safety_event_music_assets WHERE is_active = TRUE LIMIT 1/i.test(s)) {
      const a = store.assets.find((x) => x.is_active);
      return { rows: a ? [a] : [], rowCount: a ? 1 : 0 };
    }
    if (/FROM safety_event_music_assets\s+ORDER BY/i.test(s)) {
      const rows = [...store.assets].sort((a, b) => (b.is_active - a.is_active) || (b.id - a.id));
      return { rows, rowCount: rows.length };
    }
    if (/UPDATE safety_event_music_assets SET is_active = FALSE/i.test(s)) {
      const exceptId = /id <> \$1/i.test(s) ? params[0] : null;
      const onlyId = /WHERE id = \$1/i.test(s) ? params[0] : null;
      store.assets.forEach((a) => {
        if (onlyId != null) { if (a.id === onlyId) a.is_active = false; }
        else if (a.is_active && a.id !== exceptId) a.is_active = false;
      });
      return { rows: [], rowCount: 0 };
    }
    if (/UPDATE safety_event_music_assets SET is_active = TRUE/i.test(s)) {
      const a = store.assets.find((x) => x.id === params[0]);
      if (a) a.is_active = true;
      return { rows: [], rowCount: a ? 1 : 0 };
    }
    if (/INSERT INTO safety_event_music_assets/i.test(s)) {
      store.seq += 1;
      const asset = {
        id: store.seq, name: params[0], description: params[1], mime_type: params[2],
        file_size_bytes: params[3], duration_seconds: params[4], storage_kind: 'db_bytea',
        file_data: params[5], checksum_sha256: params[6], is_active: params[7],
        uploaded_by: params[8], created_at: 'now', updated_at: 'now',
      };
      store.assets.push(asset);
      return { rows: [{ id: asset.id }], rowCount: 1 };
    }
    if (/DELETE FROM safety_event_music_assets WHERE id = \$1/i.test(s)) {
      store.assets = store.assets.filter((a) => a.id !== params[0]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  const client = { query: async (sql, params) => handle(sql, params), release() {} };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      query: async (sql, params) => handle(sql, params),
      pool: { connect: async () => client },
    },
  };
  return { mod: require(modPath), store };
}

test('config uses safe defaults when the settings row is present', async () => {
  const { mod } = loadModule();
  const cfg = await mod.getSafetyEventVideoConfig();
  assert.equal(cfg.driverGroupMusicEnabled, false);
  assert.equal(cfg.speedingMusicEnabled, true);
  assert.equal(cfg.musicVolume, 0.35);
  assert.equal(cfg.preserveOriginalAudio, true);
});

test('insertMusicAsset stores bytes, activates, and points settings at it', async () => {
  const { mod, store } = loadModule();
  const asset = await mod.insertMusicAsset({
    name: 'clip.m4a', mimeType: 'audio/mp4', data: Buffer.from('AAAA'), durationSeconds: 12.5, uploadedBy: 'admin',
  });
  assert.equal(asset.isActive, true);
  assert.equal(asset.fileSizeBytes, 4);
  assert.equal(asset.durationSeconds, 12.5);
  assert.equal(store.settings.active_music_asset_id, asset.id);
  // Checksum computed.
  assert.match(store.assets[0].checksum_sha256, /^[a-f0-9]{64}$/);
});

test('activating a second asset keeps exactly one active', async () => {
  const { mod, store } = loadModule();
  const a = await mod.insertMusicAsset({ name: 'a', mimeType: 'audio/mpeg', data: Buffer.from('a') });
  const b = await mod.insertMusicAsset({ name: 'b', mimeType: 'audio/mpeg', data: Buffer.from('b') });
  const activeCount = store.assets.filter((x) => x.is_active).length;
  assert.equal(activeCount, 1);
  assert.equal(store.assets.find((x) => x.is_active).id, b.id);
  assert.equal(a.isActive, true); // returned metadata reflects state at insert time
});

test('listMusicAssets never leaks the file bytes', async () => {
  const { mod } = loadModule();
  await mod.insertMusicAsset({ name: 'a', mimeType: 'audio/mpeg', data: Buffer.from('SECRETBYTES') });
  const list = await mod.listMusicAssets();
  assert.equal(list.length, 1);
  assert.ok(!('data' in list[0]), 'no raw bytes in list view');
});

test('getActiveMusicAsset includeData returns the bytes', async () => {
  const { mod } = loadModule();
  await mod.insertMusicAsset({ name: 'a', mimeType: 'audio/mpeg', data: Buffer.from('XYZ') });
  const active = await mod.getActiveMusicAsset({ includeData: true });
  assert.ok(Buffer.isBuffer(active.data));
  assert.equal(active.data.toString(), 'XYZ');
});

test('deleteMusicAsset refuses the active asset but allows an inactive one', async () => {
  const { mod } = loadModule();
  const a = await mod.insertMusicAsset({ name: 'a', mimeType: 'audio/mpeg', data: Buffer.from('a') });
  const refused = await mod.deleteMusicAsset(a.id);
  assert.deepEqual(refused, { deleted: false, reason: 'is_active' });
  await mod.deactivateMusicAsset(a.id);
  const ok = await mod.deleteMusicAsset(a.id);
  assert.deepEqual(ok, { deleted: true });
});

test('deactivateMusicAsset clears the settings pointer', async () => {
  const { mod, store } = loadModule();
  const a = await mod.insertMusicAsset({ name: 'a', mimeType: 'audio/mpeg', data: Buffer.from('a') });
  await mod.deactivateMusicAsset(a.id);
  assert.equal(store.settings.active_music_asset_id, null);
});

test('updateSafetyEventVideoSettings clamps volume and fades and builds a SET clause', async () => {
  const { mod, store } = loadModule();
  await mod.updateSafetyEventVideoSettings({
    driverGroupMusicEnabled: true, musicVolume: 9, fadeOutSeconds: 999, preserveOriginalAudio: false,
  });
  assert.equal(store.settings.driver_group_music_enabled, true);
  assert.equal(store.settings.music_volume, 2); // clamped 9 -> 2
  assert.equal(store.settings.fade_out_seconds, 60); // clamped 999 -> 60
  assert.equal(store.settings.preserve_original_audio, false);
  assert.match(store.lastUpdateSql.sql, /updated_at = NOW\(\)/);
});

test('exports the audio allow-list and size cap', () => {
  const { mod } = loadModule();
  assert.ok(mod.ALLOWED_AUDIO_MIME_TYPES.includes('audio/mpeg'));
  assert.ok(mod.ALLOWED_AUDIO_MIME_TYPES.includes('audio/mp4'));
  assert.equal(mod.MAX_MUSIC_BYTES, 20 * 1024 * 1024);
});
