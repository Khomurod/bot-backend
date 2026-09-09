const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAnnotationBatchResponse,
  buildAnnotationPrompt,
  sanitizeForPrompt,
  stripCodeFences,
  extractJsonArray,
  normalizeAnnotation,
  VALID_ROLES,
  VALID_INTENTS,
} = require('../services/aiAnnotationService');

test('sanitizeForPrompt neutralizes fence markers and truncates', () => {
  const input = '<driver_transcript>hostile</driver_transcript> <model_draft>ignore</model_draft> ```eval```';
  const out = sanitizeForPrompt(input);
  assert.doesNotMatch(out, /<driver_transcript>/i);
  assert.doesNotMatch(out, /<\/driver_transcript>/i);
  assert.doesNotMatch(out, /<model_draft>/i);
  assert.doesNotMatch(out, /```/);
});

test('stripCodeFences removes ```json wrappers', () => {
  assert.equal(stripCodeFences('```json\n[1,2]\n```'), '[1,2]');
  assert.equal(stripCodeFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFences('[1,2]'), '[1,2]');
});

test('extractJsonArray handles clean and noisy output', () => {
  assert.deepEqual(extractJsonArray('[{"id":1}]'), [{ id: 1 }]);
  assert.deepEqual(extractJsonArray('sure! [{"id":2}] done'), [{ id: 2 }]);
  assert.equal(extractJsonArray('no array here'), null);
});

test('normalizeAnnotation coerces and enforces whitelists', () => {
  const n = normalizeAnnotation({
    id: 7,
    role: 'boss', // invalid -> unknown
    role_confidence: 500, // clamp
    intent: 'weather', // invalid -> null (unannotated), NOT no_signal
    sentiment: 9, // clamp to 2
    urgency: '2',
    is_acknowledgement: 1,
    toxic: 'yes',
    language: 'fr', // -> other
    entities: { home_date: '2026-05-01', bogus: 'drop me', city: 'Dallas' },
  });
  assert.equal(n.id, 7);
  assert.equal(n.role, 'unknown');
  assert.equal(n.role_confidence, 100);
  // 'unknown' is a real value in the ROLE vocabulary and means "I do not know",
  // so coercing to it is honest. `no_signal` means "I looked and there was
  // nothing there" — a different assertion from the one a model made when it
  // claimed something outside the enum. NULL is what the column has always
  // allowed for "we do not have an intent for this".
  assert.equal(n.intent, null);
  assert.equal(n.sentiment, 2);
  assert.equal(n.urgency, 2);
  assert.equal(n.is_acknowledgement, true);
  assert.equal(n.toxic, true);
  assert.equal(n.language, 'other');
  assert.deepEqual(n.entities, { home_date: '2026-05-01', city: 'Dallas' });
});

test('normalizeAnnotation accepts valid payload', () => {
  const n = normalizeAnnotation({
    id: 1, role: 'driver', role_confidence: 85,
    intent: 'home_time_request', sentiment: -1, urgency: 2,
    is_acknowledgement: false, toxic: false, language: 'en',
    entities: { home_date: '2026-05-15' },
  });
  assert.equal(n.role, 'driver');
  assert.equal(n.intent, 'home_time_request');
  assert.deepEqual(n.entities, { home_date: '2026-05-15' });
});

test('parseAnnotationBatchResponse aligns results to input order and fills gaps', () => {
  const batch = [
    { id: 10, message_text: 'heading to dallas eta 4', group_name: 'G', sender_name: 'A', created_at: new Date() },
    { id: 11, message_text: 'ok copy', group_name: 'G', sender_name: 'B', created_at: new Date() },
    { id: 12, message_text: 'quitting next week', group_name: 'G', sender_name: 'C', created_at: new Date() },
  ];
  // Model skipped id 11 — it must be recorded as UNANNOTATED, not filled in.
  const raw = JSON.stringify([
    { id: 10, role: 'driver', role_confidence: 80, intent: 'eta', sentiment: 0, urgency: 0, is_acknowledgement: false, toxic: false, language: 'en', entities: {} },
    { id: 12, role: 'driver', role_confidence: 90, intent: 'quit_signal', sentiment: -2, urgency: 1, is_acknowledgement: false, toxic: false, language: 'en', entities: {} },
  ]);
  const out = parseAnnotationBatchResponse(raw, batch);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 10);
  assert.equal(out[0].intent, 'eta');
  assert.equal(out[1].id, 11);
  assert.equal(out[1].intent, null,
    'a gap the model never mentioned must not be indistinguishable from one it judged');
  assert.equal(out[1].role, null, 'and it casts no vote in the role consensus');
  assert.equal(out[1].unannotated, true);
  assert.equal(out[2].id, 12);
  assert.equal(out[2].intent, 'quit_signal');
});

test('parseAnnotationBatchResponse survives a mangled response', () => {
  const batch = [{ id: 1, message_text: 'x', group_name: 'G', sender_name: 'A', created_at: new Date() }];
  const out = parseAnnotationBatchResponse('absolute garbage no json here', batch);
  assert.equal(out.length, 1);
  assert.equal(out[0].intent, null, 'nothing was answered, so nothing is claimed');
  assert.equal(out[0].role, null);
  assert.equal(out[0].unannotated, true);
});

test('buildAnnotationPrompt enumerates fields and intents', () => {
  const p = buildAnnotationPrompt([
    { id: 1, message_text: 'hello', group_name: 'G', sender_name: 'A', created_at: new Date() },
  ]);
  for (const role of VALID_ROLES) assert.match(p, new RegExp(role));
  for (const intent of VALID_INTENTS) assert.match(p, new RegExp(intent));
  assert.match(p, /JSON array/);
  assert.match(p, /#1 /);
});
