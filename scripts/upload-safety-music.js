#!/usr/bin/env node
/**
 * upload-safety-music.js  →  `npm run upload-safety-music -- <file> [options]`
 *
 * Load a music clip into the database for the driver-group speeding-video music
 * overlay, WITHOUT going through the admin UI. Useful for seeding the initial
 * clip or for CI/ops. The bytes are stored in Postgres BYTEA (see
 * safety_event_music_assets) so the separate samsara-integration poller can read
 * them.
 *
 * Usage:
 *   DATABASE_URL='postgresql://…' \
 *     node scripts/upload-safety-music.js ./path/to/music.m4a \
 *       [--name "Speeding overlay"] [--description "…"] [--inactive]
 *
 * By default the uploaded clip becomes the ACTIVE one. Pass --inactive to stage
 * it without activating. Accepted types: mp3, wav, m4a, aac. Never commit the
 * audio file to git.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--inactive') args.inactive = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--description') args.description = argv[++i];
    else args._.push(a);
  }
  return args;
}

const EXT_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'audio/mp4',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args._[0];
  if (!filePath) {
    console.error('Usage: node scripts/upload-safety-music.js <file> [--name X] [--description Y] [--inactive]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('[upload-safety-music] ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.error(`[upload-safety-music] ERROR: file not found: ${abs}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const mimeType = EXT_MIME[ext];
  if (!mimeType) {
    console.error(`[upload-safety-music] ERROR: unsupported extension "${ext}". Use mp3/wav/m4a/aac.`);
    process.exit(1);
  }

  const { getAudioDurationSeconds } = require('../utils/audioDuration');
  const store = require('../database/safetyEventVideoSettings');
  const durationSeconds = getAudioDurationSeconds(buffer, mimeType);
  const name = args.name || path.basename(abs);

  console.log(`[upload-safety-music] ${name}: ${(buffer.length / (1024 * 1024)).toFixed(2)} MB, `
    + `${mimeType}, duration=${durationSeconds == null ? 'unknown' : `${durationSeconds}s`}, `
    + `active=${!args.inactive}`);

  const asset = await store.insertMusicAsset({
    name,
    description: args.description || null,
    mimeType,
    data: buffer,
    durationSeconds,
    uploadedBy: 'upload-safety-music-script',
    activate: !args.inactive,
  });

  console.log(`[upload-safety-music] stored asset id=${asset.id} active=${asset.isActive}`);
  // The db pool keeps the process alive; exit explicitly.
  const { pool } = require('../database/db');
  await pool.end().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error('[upload-safety-music] FAILED:', err.message);
  process.exit(1);
});
