'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config/config');

let client = null;

function isConfigured() {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey && config.trailerStorageBucket);
}

function getClient() {
  if (!isConfigured()) {
    const error = new Error('Trailer Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    error.status = 503;
    throw error;
  }
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return client;
}

async function uploadObject({ path, bytes, contentType, upsert = false }) {
  const { data, error } = await getClient().storage.from(config.trailerStorageBucket)
    .upload(path, bytes, { contentType, upsert, cacheControl: '3600' });
  if (error) throw Object.assign(new Error(`Storage upload failed: ${error.message}`), { status: 502 });
  return { bucket: config.trailerStorageBucket, objectPath: data.path || path };
}

async function removeObjects(paths) {
  const clean = (paths || []).filter(Boolean);
  if (!clean.length || !isConfigured()) return;
  const { error } = await getClient().storage.from(config.trailerStorageBucket).remove(clean);
  if (error) console.error('[TRAILER-STORAGE] orphan cleanup failed:', error.message);
}

async function createSignedUrl(objectPath, expiresSeconds = 300) {
  const { data, error } = await getClient().storage.from(config.trailerStorageBucket)
    .createSignedUrl(objectPath, Math.min(900, Math.max(30, Number(expiresSeconds) || 300)));
  if (error || !data?.signedUrl) throw Object.assign(new Error(`Could not create signed URL: ${error?.message || 'unknown error'}`), { status: 502 });
  return data.signedUrl;
}

module.exports = { isConfigured, uploadObject, removeObjects, createSignedUrl, getClient };
