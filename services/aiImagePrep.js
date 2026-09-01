/**
 * Prepare a COPY of an image for an outbound AI vision call.
 *
 * Phone cameras produce 8–12 MP JPEGs of several megabytes. Base64 inflates
 * them by a further ~33%, and every one of those bytes leaves Render as
 * outbound traffic. The vision models do not benefit: they downsample to
 * modest tiles internally, so a 4 MB original and a 400 KB resize read the
 * same trailer number.
 *
 * What this does, once per image:
 *   - honours the EXIF orientation flag (`.rotate()`), so a sideways phone
 *     photo is not handed to the model rotated — this alone fixes OCR failures;
 *   - bounds the long edge, WITHOUT enlarging anything already smaller;
 *   - encodes JPEG at a quality that keeps VINs, unit numbers and document
 *     text legible, stepping down only if the result is still large;
 *   - strips EXIF/ICC metadata, which can be tens of KB of pure overhead.
 *
 * IMPORTANT — this NEVER replaces a stored original. Inspection photos,
 * rental-agreement scans and payment receipts are evidence and are persisted
 * unmodified by services/trailerImageService.js. This module only shrinks the
 * transient copy that goes out to the model.
 *
 * Fail-safe: `prepareImageForAi` returns null for anything sharp cannot decode,
 * so a corrupt upload degrades to "no image evidence" rather than throwing into
 * a Telegram handler. Callers that must distinguish the two use
 * `prepareImagePartForAi`, which passes non-images (PDFs) straight through.
 */
'use strict';

const sharp = require('sharp');

/**
 * Long-edge bound. 1600px keeps small printed text — VINs, trailer unit
 * numbers, dispatch-sheet rows — comfortably readable while cutting a 12 MP
 * photo by roughly an order of magnitude.
 */
const MAX_DIMENSION = 1600;

/**
 * Quality ladder. The first attempt is what almost every image uses; the rest
 * only run for a stubbornly large frame (a dense document scan), so a typical
 * request encodes exactly once.
 */
const QUALITY_LADDER = [
  { dimension: MAX_DIMENSION, quality: 82 },
  { dimension: 1400, quality: 76 },
  { dimension: 1200, quality: 70 },
];

/** Stop stepping down once the encoded copy is this small. */
const TARGET_BYTES = 900 * 1024;

/** MIME types sharp can re-encode. Anything else is passed through untouched. */
const PREPARABLE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/tiff',
]);

function isPreparableMime(mimeType) {
  return PREPARABLE_MIMES.has(String(mimeType || '').toLowerCase().trim());
}

/**
 * Shrink one image buffer for an AI call.
 *
 * @param {Buffer} buffer  The original bytes. Never mutated.
 * @returns {Promise<{buffer: Buffer, mimeType: string, width: number|null,
 *   height: number|null, originalBytes: number, bytes: number}|null>}
 *   null when the buffer is empty or not a decodable image.
 */
async function prepareImageForAi(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  const maxDimension = Number(options.maxDimension) > 0
    ? Number(options.maxDimension)
    : MAX_DIMENSION;
  const targetBytes = Number(options.targetBytes) > 0
    ? Number(options.targetBytes)
    : TARGET_BYTES;

  // One decode probe up front: an undecodable buffer must fail here rather than
  // part-way through the ladder.
  try {
    await sharp(buffer).metadata();
  } catch (_) {
    return null;
  }

  const ladder = QUALITY_LADDER.map((step) => ({
    ...step,
    dimension: Math.min(step.dimension, maxDimension),
  }));

  let best = null;
  for (const step of ladder) {
    let encoded;
    try {
      encoded = await sharp(buffer)
        // EXIF orientation first, so the resize bounds the visual long edge.
        .rotate()
        .resize({
          width: step.dimension,
          height: step.dimension,
          fit: 'inside',
          // Never upscale: a small screenshot stays byte-for-byte small.
          withoutEnlargement: true,
        })
        .jpeg({ quality: step.quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    } catch (_) {
      // A ladder step can fail on an odd colour profile; try the next one.
      continue;
    }
    best = encoded;
    if (encoded.data.length <= targetBytes) break;
  }

  if (!best) return null;

  // Guard against the pathological case where re-encoding a tiny, already
  // optimal image makes it BIGGER. Sending the original is then strictly
  // better — but only when it is already a format the model accepts.
  const grewOnRecompress = best.data.length >= buffer.length
    && isPreparableMime(options.mimeType)
    && String(options.mimeType).toLowerCase() !== 'image/gif'
    && String(options.mimeType).toLowerCase() !== 'image/tiff';
  if (grewOnRecompress) {
    return {
      buffer,
      mimeType: String(options.mimeType).toLowerCase(),
      width: best.info?.width ?? null,
      height: best.info?.height ?? null,
      originalBytes: buffer.length,
      bytes: buffer.length,
    };
  }

  return {
    buffer: best.data,
    mimeType: 'image/jpeg',
    width: best.info?.width ?? null,
    height: best.info?.height ?? null,
    originalBytes: buffer.length,
    bytes: best.data.length,
  };
}

/**
 * Build one Gemini `inline_data` part from a buffer, shrinking it first.
 *
 * Non-image parts (a PDF dispatch sheet) and images sharp cannot decode are
 * passed through with their original bytes, so behaviour never regresses to
 * "the model got nothing".
 *
 * @returns {Promise<{inline_data: {mime_type: string, data: string}}>}
 */
async function prepareImagePartForAi(buffer, mimeType) {
  const mime = String(mimeType || 'application/octet-stream').toLowerCase();
  if (!isPreparableMime(mime)) {
    return { inline_data: { mime_type: mime, data: buffer.toString('base64') } };
  }
  const prepared = await prepareImageForAi(buffer, { mimeType: mime });
  if (!prepared) {
    return { inline_data: { mime_type: mime, data: buffer.toString('base64') } };
  }
  return {
    inline_data: {
      mime_type: prepared.mimeType,
      data: prepared.buffer.toString('base64'),
    },
  };
}

/**
 * Map a list of `{buffer, mimetype}` uploads to Gemini parts.
 *
 * Sequential on purpose: these run on a 512 MB instance, and decoding several
 * multi-megapixel images at once is what the memory budget cannot afford.
 */
async function prepareImagePartsForAi(files) {
  const parts = [];
  for (const file of files || []) {
    if (!file?.buffer) continue;
    parts.push(await prepareImagePartForAi(file.buffer, file.mimetype || file.mimeType));
  }
  return parts;
}

module.exports = {
  prepareImageForAi,
  prepareImagePartForAi,
  prepareImagePartsForAi,
  isPreparableMime,
  MAX_DIMENSION,
  TARGET_BYTES,
};
