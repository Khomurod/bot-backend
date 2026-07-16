/**
 * REPRODUCTION TEST — Trailer Department uploads without Supabase.
 *
 * Pins the CURRENT (broken) behavior reported in production: with no Supabase
 * env configured, every Trailer Department file operation throws 503. That is
 * the root of the reported failure chain:
 *
 *   photo upload throws 503
 *     -> no pickup_condition_photo row is ever written
 *       -> validateInspectionMedia() rejects  (database/trailerRentals.js)
 *         -> "Confirm Pickup and Activate" fails
 *
 * These assertions are deliberately written against today's behavior so the fix
 * is provable. When the database storage backend lands, this file inverts: the
 * unconfigured case must return the database backend and upload successfully,
 * and only the explicitly-Supabase-selected case may fail. Do not delete it —
 * flip it, so the fix stays covered.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../config/config');
const STORAGE_PATH = require.resolve('../services/trailerStorageService');

const CONFIGURED = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseServiceRoleKey: 'service-role-key',
  trailerStorageBucket: 'trailer-private',
};

/**
 * Load the storage service against a stubbed config. The service reads config
 * at require time and memoizes its client, so both modules are purged first.
 */
function loadStorageWith(configOverrides) {
  delete require.cache[STORAGE_PATH];
  delete require.cache[CONFIG_PATH];
  require.cache[CONFIG_PATH] = {
    id: CONFIG_PATH,
    filename: CONFIG_PATH,
    loaded: true,
    exports: configOverrides,
  };
  try {
    return require('../services/trailerStorageService');
  } finally {
    delete require.cache[STORAGE_PATH];
    delete require.cache[CONFIG_PATH];
  }
}

test('storage reports unconfigured when Supabase env is absent', () => {
  const storage = loadStorageWith({ ...CONFIGURED, supabaseUrl: null, supabaseServiceRoleKey: null });
  assert.equal(storage.isConfigured(), false);
});

test('storage reports unconfigured when only the bucket is missing', () => {
  const storage = loadStorageWith({ ...CONFIGURED, trailerStorageBucket: '' });
  assert.equal(storage.isConfigured(), false);
});

test('storage reports configured when every Supabase setting is present', () => {
  const storage = loadStorageWith(CONFIGURED);
  assert.equal(storage.isConfigured(), true);
});

test('REPRODUCTION: uploading a condition photo throws 503 without Supabase', async () => {
  const storage = loadStorageWith({ ...CONFIGURED, supabaseUrl: null, supabaseServiceRoleKey: null });
  await assert.rejects(
    () => storage.uploadObject({
      path: 'condition-photos/1/pickup.jpg',
      bytes: Buffer.from('fake-jpeg-bytes'),
      contentType: 'image/jpeg',
    }),
    (error) => {
      assert.equal(error.status, 503, 'upload failure is surfaced as 503 Service Unavailable');
      assert.match(error.message, /not configured/i);
      return true;
    },
  );
});

test('REPRODUCTION: reading media back throws 503 without Supabase', async () => {
  const storage = loadStorageWith({ ...CONFIGURED, supabaseUrl: null, supabaseServiceRoleKey: null });
  await assert.rejects(
    () => storage.createSignedUrl('condition-photos/1/pickup.jpg', 300),
    (error) => {
      assert.equal(error.status, 503);
      return true;
    },
  );
});

test('orphan cleanup stays silent when Supabase is unconfigured', async () => {
  // removeObjects short-circuits on !isConfigured() so failure paths can always
  // attempt cleanup. Preserve this when the storage abstraction lands.
  const storage = loadStorageWith({ ...CONFIGURED, supabaseUrl: null, supabaseServiceRoleKey: null });
  await assert.doesNotReject(() => storage.removeObjects(['condition-photos/1/pickup.jpg']));
});
