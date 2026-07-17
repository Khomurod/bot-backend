/**
 * GUARD — Trailer Department uploads must NEVER again require a Supabase bucket.
 *
 * This file previously reproduced the production failure: with Supabase
 * unconfigured every upload threw 503, so inspection photos never stored, so
 * the required pickup photo never existed, so "Confirm Pickup and Activate"
 * failed. Those assertions are now INVERTED — they prove the fix and stop it
 * from regressing.
 *
 * Here: backend selection and the fallback contract, with no database needed.
 * tests/trailerStoragePg.test.js proves bytes actually round-trip and that
 * activation succeeds, against a real PostgreSQL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const CONFIG_PATH = require.resolve('../config/config');
const FACADE_PATH = require.resolve('../services/trailerStorageService');
const STORAGE_DIR = path.resolve(__dirname, '../services/trailerStorage');
const POOL_PATH = require.resolve('../database/pool');

const CONFIGURED = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseServiceRoleKey: 'service-role-key',
  trailerStorageBucket: 'trailer-private',
  jwtSecret: 'test-secret',
  renderExternalUrl: 'https://example.test',
};

/**
 * Load the storage package against a stubbed config and a pool that must never
 * be reached (these tests assert selection, not I/O).
 */
function loadStorageWith(configOverrides) {
  const purge = () => {
    for (const file of fs.readdirSync(STORAGE_DIR)) {
      if (file.endsWith('.js')) delete require.cache[path.join(STORAGE_DIR, file)];
    }
    delete require.cache[FACADE_PATH];
    delete require.cache[CONFIG_PATH];
    delete require.cache[POOL_PATH];
  };
  purge();
  require.cache[CONFIG_PATH] = {
    id: CONFIG_PATH, filename: CONFIG_PATH, loaded: true, exports: configOverrides,
  };
  require.cache[POOL_PATH] = {
    id: POOL_PATH,
    filename: POOL_PATH,
    loaded: true,
    exports: {
      pool: {},
      query: async () => { throw new Error('the database must not be reached in this test'); },
      ping: async () => true,
    },
  };
  try {
    return require('../services/trailerStorageService');
  } finally {
    purge();
  }
}

const unconfigured = () => loadStorageWith({ ...CONFIGURED, supabaseUrl: null, supabaseServiceRoleKey: null });

// ─── the fix ───

test('storage is ALWAYS usable, even with no Supabase env at all', () => {
  // This assertion is the whole point: uploads must work out of the box.
  assert.equal(unconfigured().isConfigured(), true);
});

test('with no Supabase configured the database backend is selected', () => {
  const storage = unconfigured();
  assert.equal(storage.activeBackend(), 'database');
  assert.equal(storage.isSupabaseConfigured(), false, 'and the settings screen can still say so');
});

test('a missing bucket alone still falls back to the database', () => {
  const storage = loadStorageWith({ ...CONFIGURED, trailerStorageBucket: '' });
  assert.equal(storage.activeBackend(), 'database');
});

test('when Supabase IS fully configured it is used, unchanged', () => {
  // Existing deployments must behave exactly as before.
  const storage = loadStorageWith(CONFIGURED);
  assert.equal(storage.activeBackend(), 'supabase');
  assert.equal(storage.isSupabaseConfigured(), true);
});

test('the database backend needs no configuration by definition', () => {
  assert.equal(unconfigured().databaseBackend.isConfigured(), true);
});

// ─── reads follow the file, not the configuration ───

test('a database-backed file is read from the database even when Supabase is configured', async () => {
  // Otherwise every file written before a bucket was added would 404 the
  // moment one is added.
  const storage = loadStorageWith(CONFIGURED);
  let askedFor = null;
  storage.databaseBackend.getObject = async (blobId) => {
    askedFor = blobId;
    return { bytes: Buffer.from('x'), mimeType: 'image/jpeg', filename: 'x.jpg' };
  };

  await storage.getObject({ id: 1, storage_backend: 'database', blob_id: 42 });

  assert.equal(askedFor, 42, 'the row says database, so the database is where we look');
});

test('a signed URL for a database-backed file points at the signed media route', async () => {
  const storage = unconfigured();
  const url = await storage.buildSignedMediaUrl(
    { id: 7, storage_backend: 'database', blob_id: 42, checksum_sha256: 'abc123' },
    { baseUrl: 'https://example.test', secret: 'test-secret' },
  );
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/api/trailer-media/7');
  assert.ok(parsed.searchParams.get('sig'), 'signed');
  assert.ok(parsed.searchParams.get('exp'), 'and expiring — never a permanent public URL');
});

test('a signed preview URL is only offered when a preview actually exists', async () => {
  const storage = unconfigured();
  const signing = { baseUrl: 'https://example.test', secret: 'test-secret' };
  const withoutPreview = await storage.buildSignedMediaUrl(
    { id: 7, storage_backend: 'database', blob_id: 42, checksum_sha256: 'abc123' },
    { preview: true, ...signing },
  );
  assert.equal(new URL(withoutPreview).searchParams.get('p'), 'original', 'falls back rather than 404');

  const withPreview = await storage.buildSignedMediaUrl(
    { id: 7, storage_backend: 'database', blob_id: 42, preview_blob_id: 43, checksum_sha256: 'abc123' },
    { preview: true, ...signing },
  );
  assert.equal(new URL(withPreview).searchParams.get('p'), 'preview');
});

// ─── cleanup must stay silent ───

test('orphan cleanup never throws, whichever backend wrote the file', async () => {
  // Cleanup runs on the failure path; if it threw it would mask the real error.
  const storage = unconfigured();
  storage.databaseBackend.removeObjects = async () => {};
  await assert.doesNotReject(() => storage.removeObjects([{ blobId: 1 }, { objectPath: 'a/b.jpg' }, null]));
});
