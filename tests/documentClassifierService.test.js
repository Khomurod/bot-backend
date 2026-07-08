/**
 * Tests for services/documentClassifierService.js. The Gemini call is injected
 * (deps.callJson) so we exercise the classify → normalize → safe-fallback logic
 * without any network, covering BOL / POD / unrelated / unclear, a multi-file
 * batch decision, and a malformed AI response.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const classifier = require('../services/documentClassifierService');

function fakeCall(parsed) {
  return async () => ({ parsed, text: JSON.stringify(parsed), model: 'fake' });
}
const oneFile = [{ buffer: Buffer.from('x'), mimeType: 'image/jpeg', fileName: 'a.jpg', kind: 'image' }];

test('BOL sample is classified as bol', async () => {
  const res = await classifier.classifyBatch(oneFile, {}, {
    callJson: fakeCall({ batch: { type: 'BOL', confidence: 0.92, same_load: true, summary: 'Bill of Lading header + shipper' }, evidence: ['Bill of Lading'] }),
  });
  assert.equal(res.type, 'bol');
  assert.ok(res.confidence > 0.9);
  assert.deepEqual(res.evidence, ['Bill of Lading']);
});

test('POD sample is classified as pod', async () => {
  const res = await classifier.classifyBatch(oneFile, {}, {
    callJson: fakeCall({ batch: { type: 'pod', confidence: 0.88 }, evidence: ['Proof of Delivery', 'consignee signature'], load_numbers: ['9188060'] }),
  });
  assert.equal(res.type, 'pod');
  assert.deepEqual(res.loadNumbers, ['9188060']);
});

test('unrelated sample (fuel receipt) is classified as unrelated', async () => {
  const res = await classifier.classifyBatch(oneFile, {}, {
    callJson: fakeCall({ batch: { type: 'unrelated', confidence: 0.7, summary: 'Fuel receipt' } }),
  });
  assert.equal(res.type, 'unrelated');
});

test('unclear sample stays unclear and confidence is capped low', async () => {
  const res = await classifier.classifyBatch(oneFile, {}, {
    // Even if the model over-claims confidence, unclear must not carry high confidence.
    callJson: fakeCall({ batch: { type: 'unclear', confidence: 0.99 } }),
  });
  assert.equal(res.type, 'unclear');
  assert.ok(res.confidence <= 0.4, `unclear confidence should be capped, got ${res.confidence}`);
});

test('multi-file batch yields ONE batch decision plus per-file entries', async () => {
  const files = [
    { buffer: Buffer.from('a'), mimeType: 'application/pdf', kind: 'pdf', fileName: 'p1.pdf' },
    { buffer: Buffer.from('b'), mimeType: 'image/png', kind: 'image', fileName: 'p2.png' },
  ];
  const res = await classifier.classifyBatch(files, { driverName: 'JAFAR KHALIMOV' }, {
    callJson: fakeCall({
      batch: { type: 'pod', confidence: 0.8, same_load: true },
      files: [
        { index: 0, type: 'pod', confidence: 0.8, evidence: ['Delivered'] },
        { index: 1, type: 'pod', confidence: 0.75, evidence: ['signature'] },
      ],
    }),
  });
  assert.equal(res.type, 'pod');
  assert.equal(res.sameLoad, true);
  assert.equal(res.files.length, 2);
  assert.equal(res.files[1].type, 'pod');
});

test('malformed AI response (null parsed) degrades safely to unclear', async () => {
  const res = await classifier.classifyBatch(oneFile, {}, { callJson: async () => ({ parsed: null, text: 'not json' }) });
  assert.equal(res.type, 'unclear');
  assert.equal(res.confidence, 0);
  assert.equal(res.ok, false);
});

test('thrown AI error degrades safely to unclear (needs human review)', async () => {
  const res = await classifier.classifyBatch(oneFile, {}, { callJson: async () => { throw new Error('quota'); } });
  assert.equal(res.type, 'unclear');
  assert.equal(res.error, true);
  assert.match(res.summary, /human review/i);
});

test('not configured (no key, no injected call) → unclear, configured:false', async () => {
  const res = await classifier.classifyBatch(oneFile, {}); // no deps, GEMINI_API_KEY unset in test env
  assert.equal(res.type, 'unclear');
  assert.equal(res.configured, false);
});

test('normalizeDocType maps Datatruck file_type + synonyms', () => {
  assert.equal(classifier.normalizeDocType('bill_of_lading'), 'bol');
  assert.equal(classifier.normalizeDocType('Proof of Delivery'), 'pod');
  assert.equal(classifier.normalizeDocType('garbage'), 'unclear');
});

test('datatruckFileTypeForDocType only maps bol/pod', () => {
  assert.equal(classifier.datatruckFileTypeForDocType('bol'), 'bill_of_lading');
  assert.equal(classifier.datatruckFileTypeForDocType('pod'), 'proof_of_delivery');
  assert.equal(classifier.datatruckFileTypeForDocType('both'), null);
  assert.equal(classifier.datatruckFileTypeForDocType('unclear'), null);
});
