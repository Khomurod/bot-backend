/**
 * Trailer Department file storage — backend selection.
 *
 * THE FIX for the reported production failure. Uploads used to require Supabase
 * Storage: with no bucket configured every upload threw 503, so inspection
 * photos never stored, so the required pickup photo never existed, so "Confirm
 * Pickup and Activate" failed. Storage now always works.
 *
 * Selection rule, deliberately implicit:
 *     Supabase fully configured  -> supabase   (unchanged behavior)
 *     otherwise                  -> database   (bytes in Postgres, no bucket)
 *
 * The user is never asked to create a bucket. Reads follow the backend recorded
 * ON THE FILE (`storage_backend`), not the current configuration — so files
 * written before Supabase was configured keep working forever after it is.
 *
 * services/trailerStorageService.js re-exports this package, so existing
 * importers keep working (the services/routeControl -> routeControlService
 * pattern named in CLAUDE.md).
 */
'use strict';

const databaseBackend = require('./databaseBackend');
const supabaseBackend = require('./supabaseBackend');
const mediaReference = require('./mediaReference');

/**
 * The backend NEW uploads go to. Supabase when it is fully configured,
 * otherwise the database.
 */
function activeBackend() {
  return supabaseBackend.isConfigured() ? supabaseBackend.BACKEND : databaseBackend.BACKEND;
}

/** Whether Supabase is available — surfaced on the settings screen. */
function isSupabaseConfigured() {
  return supabaseBackend.isConfigured();
}

/**
 * Storage always works now: the database backend needs no configuration. Kept
 * because the settings endpoint reports it; it no longer gates uploads.
 */
function isConfigured() {
  return true;
}

/**
 * Store one file with the active backend.
 *
 * Returns a descriptor shaped for a trailer_media row, carrying the backend it
 * actually used — reads must follow THAT, not today's configuration.
 *
 * @param {object} input { bytes, contentType, filename, checksum, objectPath }
 * @param {object} [options] { client, actor }
 * @returns {Promise<{storageBackend, blobId?, bucket?, objectPath?, byteSize}>}
 */
async function putObject(input, options = {}) {
  if (activeBackend() === supabaseBackend.BACKEND) {
    const uploaded = await supabaseBackend.uploadObject({
      path: input.objectPath,
      bytes: input.bytes,
      contentType: input.contentType,
    });
    return {
      storageBackend: supabaseBackend.BACKEND,
      bucket: uploaded.bucket,
      objectPath: uploaded.objectPath,
      byteSize: input.bytes.length,
    };
  }
  const stored = await databaseBackend.putObject(input, options);
  return {
    storageBackend: databaseBackend.BACKEND,
    blobId: stored.blobId,
    byteSize: stored.byteSize,
  };
}

/**
 * Read a stored file's bytes, following the backend recorded on the row.
 *
 * @param {object} media a trailer_media row
 * @param {object} [options] { preview: boolean, client }
 * @returns {Promise<{bytes: Buffer, mimeType: string, filename: string}|null>}
 */
async function getObject(media, options = {}) {
  if (!media) return null;
  const wantPreview = Boolean(options.preview);

  if (media.storage_backend === supabaseBackend.BACKEND) {
    // Supabase-backed reads still go through a Supabase signed URL; the caller
    // fetches it. Returning bytes here would mean proxying the whole file
    // through this process for no benefit.
    const path = wantPreview && media.preview_object_path ? media.preview_object_path : media.object_path;
    return { signedUrl: await supabaseBackend.createSignedUrl(path, options.expiresSeconds || 300) };
  }

  const blobId = wantPreview && media.preview_blob_id ? media.preview_blob_id : media.blob_id;
  if (!blobId) return null;
  return databaseBackend.getObject(blobId, options);
}

/**
 * A short-lived URL for one stored file, whichever backend holds it.
 *
 * Supabase files get a Supabase signed URL (unchanged); database files get an
 * HMAC-signed link to /api/trailer-media/:id. Callers — the admin UI, Telegram
 * delivery — do not need to care which.
 *
 * The result is a CREDENTIAL. Never log it, and never persist it.
 *
 * @param {object} media a trailer_media row
 * @param {object} [options] { preview, ttlSeconds, baseUrl, secret }
 *   baseUrl/secret default to config at call time; pass them to sign without
 *   depending on ambient configuration.
 * @returns {Promise<string>}
 */
async function buildSignedMediaUrl(media, options = {}) {
  if (!media) throw Object.assign(new Error('Media not found.'), { status: 404 });
  const wantPreview = Boolean(options.preview);

  if (media.storage_backend === supabaseBackend.BACKEND) {
    const path = wantPreview && media.preview_object_path ? media.preview_object_path : media.object_path;
    return supabaseBackend.createSignedUrl(path, options.ttlSeconds || mediaReference.DEFAULT_TTL_SECONDS);
  }
  // Only offer the preview variant when one actually exists, so a signed
  // preview link can never resolve to nothing.
  const variant = wantPreview && media.preview_blob_id ? 'preview' : 'original';
  return mediaReference.buildTrailerMediaUrl({
    mediaId: media.id,
    media,
    variant,
    ttlSeconds: options.ttlSeconds,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.secret !== undefined ? { secret: options.secret } : {}),
  });
}

/**
 * Best-effort cleanup of just-written objects when the metadata insert fails.
 * Accepts the descriptor putObject returned, so the caller does not have to
 * know which backend ran. Never throws.
 */
async function removeObjects(descriptors, options = {}) {
  const list = (Array.isArray(descriptors) ? descriptors : [descriptors]).filter(Boolean);
  const blobIds = [];
  const paths = [];
  for (const descriptor of list) {
    if (descriptor.blobId) blobIds.push(descriptor.blobId);
    if (descriptor.objectPath) paths.push(descriptor.objectPath);
  }
  if (blobIds.length) await databaseBackend.removeObjects(blobIds, options);
  if (paths.length) await supabaseBackend.removeObjects(paths);
}

module.exports = {
  activeBackend,
  isConfigured,
  isSupabaseConfigured,
  putObject,
  getObject,
  buildSignedMediaUrl,
  removeObjects,
  storageUsage: databaseBackend.storageUsage,
  // Backends are exported for the migration utility and for tests that need to
  // exercise one deliberately.
  databaseBackend,
  supabaseBackend,
  ...mediaReference,
};
