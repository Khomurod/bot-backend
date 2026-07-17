/**
 * Master-list snapshot import: AI extraction normalization + memory-safe ingest.
 *
 * The rules under test:
 *   - the AI never invents a value; unreadable becomes null and the row is flagged;
 *   - uploads are validated BEFORE any image is read or sent anywhere;
 *   - images are processed ONE AT A TIME from temp disk (this runs on a small
 *     instance and the whole fleet list can arrive as a dozen photos);
 *   - temp files are always cleaned up, on success and on failure;
 *   - a single unreadable photo does not discard the rest of the batch.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { normalizeExtractedRow } = require('../services/trailerMasterList/extraction');

const EXTRACTION_PATH = require.resolve('../services/trailerMasterList/extraction');
const INGEST_PATH = require.resolve('../services/trailerMasterList/imageIngest');

// ─── extraction normalization ───

test('a fully-read row is trusted and not flagged', () => {
  const row = normalizeExtractedRow({
    unit_number: 't-100', make: 'Wabash', vin: '1ABC', row_confidence: 98,
    field_confidence: { unit_number: 99, vin: 95 },
  }, 0);
  assert.equal(row.unit_number, 'T-100', 'unit numbers are normalized on the way in');
  assert.equal(row.needs_review, false);
  assert.equal(row.source_image_index, 0, 'the reviewer can find the source photo');
  assert.deepEqual(row.field_confidence, { unit_number: 99, vin: 95 });
});

test("the model's spellings of empty never become data", () => {
  const row = normalizeExtractedRow({
    unit_number: 'T-100', make: 'null', model: 'N/A', vin: '-', type: '  ', year: 'unknown',
    row_confidence: 95, field_confidence: { unit_number: 99 },
  }, 0);
  assert.equal(row.make, null);
  assert.equal(row.model, null);
  assert.equal(row.vin, null);
  assert.equal(row.type, null);
  assert.equal(row.year, null);
});

test('a low-confidence row is flagged for review', () => {
  const row = normalizeExtractedRow({ unit_number: 'T-100', make: 'Wabash', row_confidence: 40 }, 0);
  assert.equal(row.needs_review, true);
});

test('a low-confidence UNIT NUMBER is flagged even when the row looks confident', () => {
  // Identity is what everything else hangs off: a shaky unit number is never
  // safe to trust, however sure the model is about the rest of the row.
  const row = normalizeExtractedRow({
    unit_number: 'T-1OO', make: 'Wabash', vin: '1ABC', row_confidence: 97,
    field_confidence: { unit_number: 35, make: 99 },
  }, 0);
  assert.equal(row.needs_review, true);
});

test('fields the model called unclear are flagged and recorded', () => {
  const row = normalizeExtractedRow({
    unit_number: 'T-100', vin: '1ABC', row_confidence: 95,
    field_confidence: { unit_number: 99 }, unclear_fields: ['vin'], notes: 'row cut off',
  }, 1);
  assert.equal(row.needs_review, true);
  assert.deepEqual(row.conflict_details.unclear_fields, ['vin']);
  assert.equal(row.conflict_details.notes, 'row cut off');
});

test('a row with no unit number is flagged rather than dropped silently', () => {
  const row = normalizeExtractedRow({ unit_number: null, make: 'Wabash', row_confidence: 99 }, 0);
  assert.equal(row.unit_number, null);
  assert.equal(row.needs_review, true);
});

test('confidence is clamped and junk confidence becomes null', () => {
  assert.equal(normalizeExtractedRow({ unit_number: 'T-1', row_confidence: 150 }, 0).confidence, 100);
  assert.equal(normalizeExtractedRow({ unit_number: 'T-1', row_confidence: -5 }, 0).confidence, 0);
  assert.equal(normalizeExtractedRow({ unit_number: 'T-1', row_confidence: 'abc' }, 0).confidence, null);
});

test('the raw AI row is preserved for audit', () => {
  const raw = { unit_number: 'T-100', row_confidence: 90, something_unexpected: true };
  assert.deepEqual(normalizeExtractedRow(raw, 0).raw_row, raw);
});

// ─── upload validation ───

/** Load the ingest module with extraction stubbed, so no AI is ever called. */
function loadIngest(extractImpl) {
  delete require.cache[INGEST_PATH];
  delete require.cache[EXTRACTION_PATH];
  const real = require('../services/trailerMasterList/extraction');
  require.cache[EXTRACTION_PATH] = {
    id: EXTRACTION_PATH,
    filename: EXTRACTION_PATH,
    loaded: true,
    exports: { ...real, extractRowsFromImage: extractImpl },
  };
  try {
    return require('../services/trailerMasterList/imageIngest');
  } finally {
    delete require.cache[INGEST_PATH];
    delete require.cache[EXTRACTION_PATH];
  }
}

/** A multer-shaped disk file backed by a real temp file. */
async function tempFile(name = 'list.jpg', bytes = Buffer.from('fake-image'), mimetype = 'image/jpeg') {
  const filePath = path.join(os.tmpdir(), `trailer-test-${crypto.randomUUID()}-${name}`);
  await fs.writeFile(filePath, bytes);
  return { path: filePath, originalname: name, mimetype, size: bytes.length };
}

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

test('an empty upload is rejected', () => {
  const { validateUpload } = loadIngest(async () => ({ rows: [], rawText: null }));
  assert.throws(() => validateUpload([]), /at least one photo/i);
});

test('a non-image file is rejected before any AI work', () => {
  const { validateUpload } = loadIngest(async () => ({ rows: [], rawText: null }));
  assert.throws(
    () => validateUpload([{ path: '/tmp/x.pdf', mimetype: 'application/pdf', size: 10, originalname: 'x.pdf' }]),
    /not a JPEG, PNG or WebP/i,
  );
});

test('an in-memory upload is refused outright', () => {
  // multer memoryStorage would defeat the whole point: the list can be a dozen
  // photos and this runs on a memory-constrained instance.
  const { validateUpload } = loadIngest(async () => ({ rows: [], rawText: null }));
  assert.throws(
    () => validateUpload([{ buffer: Buffer.alloc(10), mimetype: 'image/jpeg', size: 10, originalname: 'a.jpg' }]),
    /temporary disk/i,
  );
});

test('too many images are rejected with the configured limit named', () => {
  const { validateUpload, limits } = loadIngest(async () => ({ rows: [], rawText: null }));
  const files = Array.from({ length: limits().maxImages + 1 }, (_, i) => (
    { path: `/tmp/${i}.jpg`, mimetype: 'image/jpeg', size: 100, originalname: `${i}.jpg` }
  ));
  assert.throws(() => validateUpload(files), /Too many images/i);
});

test('an oversized image is rejected', () => {
  const { validateUpload, limits } = loadIngest(async () => ({ rows: [], rawText: null }));
  assert.throws(
    () => validateUpload([{
      path: '/tmp/big.jpg', mimetype: 'image/jpeg', originalname: 'big.jpg',
      size: limits().maxBytesPerImage + 1,
    }]),
    /the limit is/i,
  );
});

test('an upload over the total cap is rejected even when each image is legal', () => {
  const { validateUpload, limits } = loadIngest(async () => ({ rows: [], rawText: null }));
  const { maxBytesPerImage, maxTotalBytes } = limits();
  const count = Math.ceil(maxTotalBytes / maxBytesPerImage) + 1;
  const files = Array.from({ length: count }, (_, i) => (
    { path: `/tmp/${i}.jpg`, mimetype: 'image/jpeg', size: maxBytesPerImage, originalname: `${i}.jpg` }
  ));
  assert.throws(() => validateUpload(files), /Split the list across two imports|Too many images/i);
});

// ─── sequential, memory-safe extraction ───

test('images are read ONE AT A TIME, never all at once', async (t) => {
  let concurrent = 0;
  let peak = 0;
  const { extractSnapshot } = loadIngest(async (image, index) => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
    return { rows: [{ unit_number: `T-${index}`, source_image_index: index }], rawText: 'raw' };
  });

  const files = [await tempFile('a.jpg'), await tempFile('b.jpg'), await tempFile('c.jpg')];
  t.after(async () => { for (const f of files) await fs.unlink(f.path).catch(() => {}); });

  const result = await extractSnapshot(files);

  assert.equal(peak, 1, 'peak memory is ONE image, not the whole upload');
  assert.equal(result.rows.length, 3);
  assert.equal(result.imageCount, 3);
});

test('each row records which photo it came from', async (t) => {
  const { extractSnapshot } = loadIngest(async (image, index) => (
    { rows: [{ unit_number: `T-${index}`, source_image_index: index }], rawText: null }
  ));
  const files = [await tempFile('a.jpg'), await tempFile('b.jpg')];
  t.after(async () => { for (const f of files) await fs.unlink(f.path).catch(() => {}); });

  const result = await extractSnapshot(files);

  assert.deepEqual(result.rows.map((r) => r.source_image_index).sort(), [0, 1]);
});

test('trailers repeated across overlapping photos collapse to one row', async (t) => {
  const { extractSnapshot } = loadIngest(async (image, index) => (
    // Both photos show T-100; only the second also shows T-200.
    { rows: index === 0
      ? [{ unit_number: 'T-100', vin: '1ABC', source_image_index: 0 }]
      : [{ unit_number: 'T-100', vin: '1ABC', source_image_index: 1 }, { unit_number: 'T-200', source_image_index: 1 }],
    rawText: null }
  ));
  const files = [await tempFile('a.jpg'), await tempFile('b.jpg')];
  t.after(async () => { for (const f of files) await fs.unlink(f.path).catch(() => {}); });

  const result = await extractSnapshot(files);

  assert.equal(result.extractedRowCount, 3, 'three rows were read');
  assert.equal(result.rows.length, 2, 'two real trailers remain');
  assert.equal(result.duplicateGroups.length, 1, 'the overlap is reported, not treated as an error');
});

test('one unreadable photo does not discard the others', async (t) => {
  const { extractSnapshot } = loadIngest(async (image, index) => {
    if (index === 1) throw new Error('image too blurry to read');
    return { rows: [{ unit_number: `T-${index}` }], rawText: null };
  });
  const files = [await tempFile('a.jpg'), await tempFile('bad.jpg'), await tempFile('c.jpg')];
  t.after(async () => { for (const f of files) await fs.unlink(f.path).catch(() => {}); });

  const result = await extractSnapshot(files);

  assert.equal(result.rows.length, 2, 'the readable photos still contribute');
  assert.equal(result.failures.length, 1, 'the failure is surfaced — the snapshot may be incomplete');
  assert.equal(result.failures[0].file_name, 'bad.jpg');
});

test('an unconfigured AI fails the whole import rather than staging a partial list', async (t) => {
  // A partial snapshot must never be mistaken for the complete official list.
  const { extractSnapshot } = loadIngest(async () => {
    throw Object.assign(new Error('AI vision is not configured'), { status: 503 });
  });
  const files = [await tempFile('a.jpg')];
  t.after(async () => { for (const f of files) await fs.unlink(f.path).catch(() => {}); });

  await assert.rejects(() => extractSnapshot(files), /not configured/i);
});

test('an import where nothing could be read fails loudly', async (t) => {
  const { extractSnapshot } = loadIngest(async () => { throw new Error('unreadable'); });
  const files = [await tempFile('a.jpg')];
  t.after(async () => { for (const f of files) await fs.unlink(f.path).catch(() => {}); });

  await assert.rejects(() => extractSnapshot(files), /No trailer rows could be read/i);
});

// ─── temp file cleanup ───

test('temp files are removed after a successful ingest', async () => {
  const { cleanupTempFiles } = loadIngest(async () => ({ rows: [], rawText: null }));
  const files = [await tempFile('a.jpg'), await tempFile('b.jpg')];
  assert.equal(await exists(files[0].path), true);

  await cleanupTempFiles(files);

  for (const file of files) assert.equal(await exists(file.path), false, 'no photo is left behind');
});

test('cleanup of an already-deleted file never throws', async () => {
  const { cleanupTempFiles } = loadIngest(async () => ({ rows: [], rawText: null }));
  const file = await tempFile('gone.jpg');
  await fs.unlink(file.path);

  // Cleanup runs in a finally block; if it threw it would mask the real error.
  await assert.doesNotReject(() => cleanupTempFiles([file, { path: null }, undefined]));
});
