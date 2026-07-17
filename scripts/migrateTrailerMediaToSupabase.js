#!/usr/bin/env node
/**
 * Copy database-backed Trailer Department files into Supabase Storage.
 *
 * MANUAL AND OPT-IN. Nothing calls this; it never runs on boot or deploy. It
 * exists so a deployment that later configures Supabase can move its existing
 * files there — the database backend is a permanent, supported option, not a
 * staging area, so there is no obligation to ever run this.
 *
 * COPIES ONLY. The blob rows are left exactly where they are:
 *   - a half-finished migration must never lose a photo;
 *   - the file keeps reading throughout, because storage_backend is only
 *     flipped once the bytes are confirmed in Supabase;
 *   - reclaiming the space afterwards is a separate, deliberate decision made
 *     by a human who has verified the copy.
 *
 * Usage:
 *   node scripts/migrateTrailerMediaToSupabase.js --dry-run     # report only
 *   node scripts/migrateTrailerMediaToSupabase.js               # copy
 *   node scripts/migrateTrailerMediaToSupabase.js --limit 100   # in batches
 *
 * Safe to re-run: already-migrated rows are skipped.
 */
'use strict';

const path = require('node:path');

const { pool, query } = require('../database/pool');
const storage = require('../services/trailerStorage');

function parseArgs(argv) {
  const args = { dryRun: false, limit: 500 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    if (argv[i] === '--limit') args.limit = Math.max(1, Number(argv[i + 1]) || 500);
  }
  return args;
}

/** Object path for a migrated file, mirroring the live upload layout. */
function objectPathFor(media, suffix) {
  const namespace = media.media_type === 'payment_receipt' ? 'payment-receipts' : 'condition-photos';
  const scope = media.rental_id || media.trailer_id || 'unassigned';
  const extension = path.extname(media.original_filename || '').toLowerCase()
    || (media.mime_type === 'application/pdf' ? '.pdf' : '.bin');
  return `${namespace}/${scope}/migrated-${media.id}/${suffix}${suffix === 'preview' ? '.webp' : extension}`;
}

async function migrateOne(media, { dryRun }) {
  const blob = await storage.databaseBackend.getObject(media.blob_id);
  if (!blob?.bytes?.length) return { id: media.id, skipped: 'the blob is missing or empty' };
  if (dryRun) return { id: media.id, wouldCopy: blob.bytes.length };

  const original = await storage.supabaseBackend.uploadObject({
    path: objectPathFor(media, 'original'),
    bytes: blob.bytes,
    contentType: media.mime_type,
  });

  let previewPath = null;
  if (media.preview_blob_id) {
    const preview = await storage.databaseBackend.getObject(media.preview_blob_id);
    if (preview?.bytes?.length) {
      previewPath = objectPathFor(media, 'preview');
      await storage.supabaseBackend.uploadObject({
        path: previewPath, bytes: preview.bytes, contentType: 'image/webp',
      });
    }
  }

  // Only NOW does the row start reading from Supabase. blob_id is deliberately
  // left in place: the bytes stay recoverable, and nothing is destroyed by a
  // migration that turns out to have been a mistake.
  await query(
    `UPDATE trailer_media
        SET storage_backend = 'supabase', bucket = $2, object_path = $3, preview_object_path = $4
      WHERE id = $1`,
    [media.id, original.bucket, original.objectPath, previewPath],
  );
  return { id: media.id, copied: blob.bytes.length };
}

async function main() {
  const args = parseArgs(process.argv);

  if (!storage.isSupabaseConfigured()) {
    console.error('Supabase is not configured. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and');
    console.error('TRAILER_STORAGE_BUCKET before migrating. Files keep working in the database');
    console.error('either way — this migration is optional.');
    process.exitCode = 1;
    return;
  }

  const pending = await query(
    `SELECT id, media_type, trailer_id, rental_id, blob_id, preview_blob_id, original_filename, mime_type
       FROM trailer_media
      WHERE storage_backend = 'database' AND blob_id IS NOT NULL
      ORDER BY id
      LIMIT $1`,
    [args.limit],
  );

  if (!pending.rows.length) {
    console.log('Nothing to migrate: no database-backed files remain.');
    return;
  }
  console.log(`${args.dryRun ? 'Would migrate' : 'Migrating'} ${pending.rows.length} file(s)…`);

  let copied = 0;
  let failed = 0;
  for (const media of pending.rows) {
    try {
      const result = await migrateOne(media, args);
      if (result.skipped) console.warn(`  media ${result.id}: skipped — ${result.skipped}`);
      else copied += 1;
    } catch (error) {
      // Keep going: one bad file must not strand the rest, and nothing has been
      // destroyed, so a retry is always safe.
      failed += 1;
      console.error(`  media ${media.id}: FAILED — ${error.message}`);
    }
  }

  console.log(`\n${args.dryRun ? 'Would copy' : 'Copied'}: ${copied}   Failed: ${failed}`);
  if (!args.dryRun && copied) {
    console.log('The original bytes are still in trailer_media_blobs. Verify the files in Supabase');
    console.log('before deciding whether to reclaim that space — that step is deliberately manual.');
  }
}

main()
  .catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
