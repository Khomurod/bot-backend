/**
 * Images sent to AI vision must be a SHRUNK COPY, never the phone original.
 *
 * A 12 MP camera JPEG is several megabytes, and base64 inflates it by a further
 * third before it leaves Render. The model gains nothing from those bytes — it
 * downsamples internally — so this is pure outbound waste on a metered plan.
 *
 * What these tests pin:
 *   - a large photo comes out dramatically smaller;
 *   - dimensions are bounded, and a small image is never enlarged;
 *   - EXIF rotation is applied, so sideways phone photos read correctly;
 *   - small text survives at a size OCR can still use;
 *   - an undecodable buffer fails safely instead of throwing;
 *   - the ORIGINAL buffer is left untouched — evidence files are preserved;
 *   - the Gemini part actually carries the optimized bytes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
  prepareImageForAi,
  prepareImagePartForAi,
  prepareImagePartsForAi,
  isPreparableMime,
  MAX_DIMENSION,
} = require('../services/aiImagePrep');

/** A detailed photo-like image; noise defeats trivial compression, as a real photo does. */
async function makePhoto(width, height) {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let i = 0; i < pixels.length; i += channels) {
    // Deterministic pseudo-noise over a gradient — compresses like a photograph.
    const n = (i * 2654435761) % 256;
    pixels[i] = (i / channels) % 256;
    pixels[i + 1] = n;
    pixels[i + 2] = 255 - (n % 200);
  }
  return sharp(pixels, { raw: { width, height, channels } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** A document-like image carrying small high-contrast text shapes. */
async function makeDocumentScan(width, height) {
  const rows = [];
  for (let y = 60; y < height - 40; y += 44) {
    rows.push(`<text x="40" y="${y}" font-family="monospace" font-size="22" fill="#111">`
      + `VIN 1FUJGLDR8CSBP1234  UNIT SWFZ233611  MILES 1,284</text>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="#fff"/>${rows.join('')}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
}

test('a multi-megapixel phone photo shrinks dramatically', async () => {
  const original = await makePhoto(4032, 3024); // 12 MP, a normal phone camera
  const prepared = await prepareImageForAi(original, { mimeType: 'image/jpeg' });

  assert.ok(prepared, 'the photo was prepared');
  assert.equal(prepared.originalBytes, original.length);

  const ratio = prepared.bytes / original.length;
  assert.ok(ratio < 0.35, `expected a major reduction, got ${(ratio * 100).toFixed(1)}% of the original`);
  assert.ok(
    prepared.bytes < 1024 * 1024,
    `expected well under a megabyte, got ${Math.round(prepared.bytes / 1024)}KB`,
  );

  // Report the real numbers so the saving is visible in the test output.
  console.log(
    `[ai-image] ${Math.round(original.length / 1024)}KB → ${Math.round(prepared.bytes / 1024)}KB `
    + `(${prepared.width}x${prepared.height})`,
  );
});

test('dimensions are bounded to the long-edge limit', async () => {
  const original = await makePhoto(4000, 2000);
  const prepared = await prepareImageForAi(original, { mimeType: 'image/jpeg' });

  assert.ok(prepared.width <= MAX_DIMENSION, `width ${prepared.width} within ${MAX_DIMENSION}`);
  assert.ok(prepared.height <= MAX_DIMENSION, `height ${prepared.height} within ${MAX_DIMENSION}`);
  // Aspect ratio preserved — a squashed frame would wreck OCR.
  assert.ok(Math.abs((prepared.width / prepared.height) - 2) < 0.02);
});

test('an already-small image is never enlarged', async () => {
  const small = await makePhoto(640, 480);
  const prepared = await prepareImageForAi(small, { mimeType: 'image/jpeg' });

  assert.equal(prepared.width, 640, 'width unchanged');
  assert.equal(prepared.height, 480, 'height unchanged');
  assert.ok(
    prepared.bytes <= small.length,
    'and re-encoding never makes a small image larger to send',
  );
});

test('EXIF orientation is applied, not passed through sideways', async () => {
  // Stored landscape but tagged "rotate 90 on display" — what a phone held
  // sideways produces. Ignoring the tag hands the model a sideways photo.
  const landscape = await sharp({
    create: { width: 1200, height: 600, channels: 3, background: { r: 20, g: 90, b: 160 } },
  }).jpeg().toBuffer();
  const rotatedTag = await sharp(landscape).withMetadata({ orientation: 6 }).toBuffer();

  assert.equal((await sharp(rotatedTag).metadata()).width, 1200, 'stored landscape');

  const prepared = await prepareImageForAi(rotatedTag, { mimeType: 'image/jpeg' });
  assert.ok(prepared, 'prepared');
  assert.ok(
    prepared.height > prepared.width,
    `orientation 6 must yield a portrait frame, got ${prepared.width}x${prepared.height}`,
  );
});

test('small document text stays legible after optimization', async () => {
  const scan = await makeDocumentScan(2400, 1600);
  const prepared = await prepareImageForAi(scan, { mimeType: 'image/jpeg' });

  assert.ok(prepared.bytes < scan.length, 'smaller than the scan');
  // The long edge is capped, but the text rows must not be shrunk past reading
  // size: at 1600px wide a 22px glyph is still ~15px tall.
  assert.ok(prepared.width >= 1200, `kept ${prepared.width}px of width for OCR`);

  const stats = await sharp(prepared.buffer).stats();
  // A blank or blown-out result would have near-zero variation; real text does not.
  assert.ok(stats.channels[0].stdev > 5, 'text contrast survived compression');
});

test('an invalid image fails safely instead of throwing', async () => {
  assert.equal(await prepareImageForAi(Buffer.from('this is not an image')), null);
  assert.equal(await prepareImageForAi(Buffer.alloc(0)), null);
  assert.equal(await prepareImageForAi(null), null);
  assert.equal(await prepareImageForAi('not a buffer'), null);
});

test('the original buffer is never mutated — evidence is preserved', async () => {
  const original = await makePhoto(2400, 1800);
  const before = Buffer.from(original); // independent copy

  const prepared = await prepareImageForAi(original, { mimeType: 'image/jpeg' });

  assert.ok(original.equals(before), 'the caller still holds the untouched original');
  assert.ok(!prepared.buffer.equals(original), 'and the AI copy is a different buffer');
});

test('the Gemini part carries the optimized bytes, not the original', async () => {
  const original = await makePhoto(4032, 3024);
  const part = await prepareImagePartForAi(original, 'image/jpeg');

  assert.equal(part.inline_data.mime_type, 'image/jpeg');
  const sent = Buffer.from(part.inline_data.data, 'base64');
  assert.ok(
    sent.length < original.length * 0.35,
    `the wire payload is the shrunk copy (${Math.round(sent.length / 1024)}KB `
    + `vs ${Math.round(original.length / 1024)}KB)`,
  );
  assert.ok(!sent.equals(original), 'not the original bytes');

  // And it is still a decodable image the model can read.
  const meta = await sharp(sent).metadata();
  assert.ok(meta.width > 0 && meta.height > 0);
});

test('a PDF passes through untouched — only images are re-encoded', async () => {
  const pdf = Buffer.from('%PDF-1.4\nfake dispatch sheet\n%%EOF');
  const part = await prepareImagePartForAi(pdf, 'application/pdf');

  assert.equal(part.inline_data.mime_type, 'application/pdf');
  assert.equal(part.inline_data.data, pdf.toString('base64'), 'byte-identical');
  assert.equal(isPreparableMime('application/pdf'), false);
});

test('an undecodable image still reaches the model rather than being dropped', async () => {
  // Fail-open: a format sharp cannot read is sent as-is, so behaviour never
  // regresses to "the model got nothing".
  const bogus = Buffer.from('\xff\xd8\xff not really a jpeg');
  const part = await prepareImagePartForAi(bogus, 'image/jpeg');

  assert.equal(part.inline_data.data, bogus.toString('base64'));
});

test('a batch of uploads is optimized one by one', async () => {
  const files = [
    { buffer: await makePhoto(3000, 2000), mimetype: 'image/jpeg' },
    { buffer: await makePhoto(2400, 1800), mimetype: 'image/jpeg' },
    { buffer: Buffer.from('%PDF-1.4\n%%EOF'), mimetype: 'application/pdf' },
    { buffer: null, mimetype: 'image/jpeg' }, // skipped
  ];
  const originalTotal = files.slice(0, 2).reduce((sum, f) => sum + f.buffer.length, 0);

  const parts = await prepareImagePartsForAi(files);

  assert.equal(parts.length, 3, 'three usable parts, the empty one skipped');
  const sentTotal = parts.slice(0, 2)
    .reduce((sum, p) => sum + Buffer.from(p.inline_data.data, 'base64').length, 0);
  assert.ok(sentTotal < originalTotal * 0.35, 'the whole batch shrank');
  assert.equal(parts[2].inline_data.mime_type, 'application/pdf');
});
