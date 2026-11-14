'use strict';

/**
 * services/hiringStages/cdlReading.js — asking a vision model what a CDL says
 * (owner, 14 November 2026). Only the post's photos leave, downloaded in
 * memory; nothing is asked while the task is off or has no provider; an
 * unsure answer reads as unsure; every value is checked. The router and the
 * download are fakes; every value is made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { readCdl, validateShape, SYSTEM } = require('../services/hiringStages/cdlReading');
const { AiUnavailableError } = require('../services/ai/router');

const IMAGES = [
  { fileId: 'front', mimeType: 'image/jpeg', size: 1000 },
  { fileId: 'back', mimeType: 'image/jpeg', size: 1000 },
];
const answer = (parsed, over = {}) => ({
  parsed, text: JSON.stringify(parsed), provider: 'gemini', model: 'gemini-2.5-flash', uncertain: false, ...over,
});
const GOOD = {
  is_cdl: true, front_photo: 1, back_photo: 2, unclear: false, confidence: 93,
  fields: { first_name: 'KWAME', last_name: 'ASANTE', date_of_birth: '1988-04-12', license_number: 'A1234567', weight: 'heavy' },
};

function deps(over = {}) {
  const asked = [];
  const downloaded = [];
  return {
    asked,
    downloaded,
    readiness: async () => 'ready',
    download: async (fileId, limits) => { downloaded.push({ fileId, limits }); return Buffer.from(fileId); },
    prepareImagePart: async (buffer, mimeType) => ({ inline_data: { mime_type: mimeType, data: buffer.toString('base64') } }),
    runCapability: async (args) => { asked.push(args); return answer(GOOD); },
    providerLabel: async (key) => (key === 'gemini' ? 'Google Gemini' : key),
    today: '2026-11-14',
    ...over,
  };
}

test('the photos are downloaded in memory and sent as numbered pictures — no message text', async () => {
  const d = deps();
  const out = await readCdl({ images: IMAGES }, d);
  assert.deepEqual(d.downloaded.map((x) => x.fileId), ['front', 'back']);
  assert.ok(d.downloaded.every((x) => x.limits.maxBytes === 10 * 1024 * 1024));
  const [args] = d.asked;
  assert.equal(args.capability, 'hiring_cdl_reading');
  assert.equal(args.expects, 'json');
  assert.deepEqual(args.extraParts.filter((p) => p.text).map((p) => p.text), ['Photo 1:', 'Photo 2:']);
  assert.equal(args.extraParts.filter((p) => p.inline_data).length, 2);
  assert.doesNotMatch(`${args.systemText}\n${args.userText}`, /555|Kwame|KWAME/, 'nothing but instructions in words');
  assert.equal(args.learning, undefined, 'never a question to the owner: a CDL value may not reach Telegram');
  assert.match(SYSTEM, /"confidence"/);
  assert.deepEqual(out, {
    status: 'read',
    values: { first_name: 'Kwame', last_name: 'Asante', date_of_birth: '1988-04-12', license_number: 'A1234567' },
    front: 1, back: 2, providerKey: 'gemini', model: 'gemini-2.5-flash', providerLabel: 'Google Gemini',
  });
});

test('SWITCHED OFF or NO PROVIDER CHOSEN: nothing is downloaded and nobody is asked', async () => {
  for (const readiness of ['off', 'no_provider']) {
    const d = deps({ readiness: async () => readiness });
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(await readCdl({ images: IMAGES }, d), { status: readiness });
    assert.equal(d.downloaded.length + d.asked.length, 0);
  }
});

test('no photo, or none would download: not read', async () => {
  assert.deepEqual(await readCdl({ images: [] }, deps()), { status: 'no_photo' });
  const d = deps({ download: async () => { throw Object.assign(new Error('x'), { kind: 'http_error' }); } });
  assert.deepEqual(await readCdl({ images: IMAGES }, d), { status: 'unreadable' });
  assert.equal(d.asked.length, 0);
  const big = deps();
  await readCdl({ images: [{ fileId: 'huge', mimeType: 'image/jpeg', size: 50 * 1024 * 1024 }, IMAGES[0]] }, big);
  assert.deepEqual(big.downloaded.map((x) => x.fileId), ['front'], 'a photo over the limit is left out');
});

test('UNSURE after the chosen providers, or saying "unclear": unsure — nothing will be written', async () => {
  let out = await readCdl({ images: IMAGES }, deps({ runCapability: async () => answer(GOOD, { uncertain: true }) }));
  assert.deepEqual([out.status, out.values], ['unsure', undefined]);
  out = await readCdl({ images: IMAGES }, deps({ runCapability: async () => answer({ ...GOOD, unclear: true }) }));
  assert.equal(out.status, 'unsure');
});

test('not a CDL, an outage, or anything thrown: unreadable, and nothing of it is kept', async () => {
  let out = await readCdl({ images: IMAGES }, deps({ runCapability: async () => answer({ is_cdl: false, confidence: 99 }) }));
  assert.equal(out.status, 'unreadable');
  out = await readCdl({ images: IMAGES }, deps({ runCapability: async () => { throw new AiUnavailableError('none'); } }));
  assert.deepEqual(out, { status: 'unreadable' });
  out = await readCdl({ images: IMAGES }, deps({ prepareImagePart: async () => { throw new TypeError('bad image'); } }));
  assert.deepEqual(out, { status: 'unreadable' });
});

test('the router\'s shape check sends a malformed answer to the next provider, and quotes nothing', () => {
  assert.equal(validateShape('', GOOD), true);
  assert.equal(validateShape('', { is_cdl: false }), true);
  assert.equal(validateShape('', { unclear: true }), true);
  assert.deepEqual(validateShape('', { is_cdl: true, fields: 'A1234567' }), { message: 'fields must be an object' });
  assert.deepEqual(validateShape('', [GOOD]), { message: 'not a JSON object' });
});
