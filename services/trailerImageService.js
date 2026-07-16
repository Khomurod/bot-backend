'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const sharp = require('sharp');

const IMAGE_MIMES = new Set(['image/jpeg','image/png','image/webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const PREVIEW_TARGET = 2 * 1024 * 1024;

function safeFilename(name) {
  const cleaned = String(name || 'upload').normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 120);
  return cleaned || 'upload';
}

async function compressPreview(input) {
  const attempts = [
    { width: 2000, quality: 82 },
    { width: 1600, quality: 75 },
    { width: 1200, quality: 68 },
  ];
  let preview;
  for (const attempt of attempts) {
    preview = await sharp(input, { failOn: 'warning' }).rotate()
      .resize({ width: attempt.width, height: attempt.width, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: attempt.quality, effort: 4 }).toBuffer();
    if (preview.length <= PREVIEW_TARGET) break;
  }
  return preview;
}

async function processTrailerUpload(file) {
  if (!file?.path) throw Object.assign(new Error('Upload file is required.'), { status: 400 });
  const original = await fs.readFile(file.path);
  const mime = String(file.mimetype || '').toLowerCase();
  const isPdf = mime === 'application/pdf';
  if (isPdf) {
    if (original.length > MAX_PDF_BYTES) throw Object.assign(new Error('PDF must be 15 MB or smaller.'), { status: 400 });
    if (original.subarray(0, 5).toString('ascii') !== '%PDF-') throw Object.assign(new Error('The uploaded file is not a valid PDF.'), { status: 400 });
  } else {
    if (!IMAGE_MIMES.has(mime)) throw Object.assign(new Error('Only JPG, PNG, WebP, and PDF files are accepted.'), { status: 400 });
    if (original.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('Image must be 10 MB or smaller.'), { status: 400 });
    try { await sharp(original, { failOn: 'warning' }).metadata(); }
    catch (_) { throw Object.assign(new Error('The uploaded file is not a valid image.'), { status: 400 }); }
  }
  const preview = isPdf ? null : await compressPreview(original);
  return {
    original,
    preview,
    mimeType: mime,
    originalFilename: safeFilename(file.originalname),
    originalSize: original.length,
    previewSize: preview?.length || null,
    checksum: crypto.createHash('sha256').update(original).digest('hex'),
  };
}

module.exports = { processTrailerUpload, safeFilename, compressPreview, IMAGE_MIMES, MAX_IMAGE_BYTES, MAX_PDF_BYTES };
