'use strict';

/**
 * The birthday card is drawn for real (sharp), from the template in assets/.
 * Made-up names; the "photo" is a generated image.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { renderBirthdayCard, normalisePhoto, STORED_PHOTO_SIZE } = require('../services/employees/birthdayCard');

const employee = { first_name: 'TESTBEK', last_name: 'EXAMPLOV', american_name: 'Sample Person' };

async function solid(width, height, rgb) {
  return sharp({ create: { width, height, channels: 3, background: rgb } }).jpeg().toBuffer();
}

async function pixel(jpeg, x, y) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('an uploaded photo is stored as a square JPEG of a fixed size', async () => {
  const stored = await normalisePhoto(await solid(600, 900, { r: 200, g: 30, b: 30 }));
  const meta = await sharp(stored).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, STORED_PHOTO_SIZE);
  assert.equal(meta.height, STORED_PHOTO_SIZE);
});

test('a file that is not an image is refused', async () => {
  await assert.rejects(() => normalisePhoto(Buffer.from('definitely not an image')));
});

test('the card is the 1080 × 1080 template with the photo in the frame', async () => {
  const photo = await normalisePhoto(await solid(800, 800, { r: 200, g: 30, b: 30 }));
  const card = await renderBirthdayCard(employee, photo);
  const meta = await sharp(card).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 1080, 1080]);
  assert.ok(near(await pixel(card, 545, 570), [200, 30, 30]), 'the photo fills the frame');
  // Outside the frame the template's navy panel is untouched.
  assert.ok(near(await pixel(card, 200, 600), [9, 39, 81]));
});

test('no photo: the frame is filled and the card still draws', async () => {
  const card = await renderBirthdayCard(employee, null);
  assert.ok(near(await pixel(card, 320, 345), [20, 55, 106]), 'placeholder colour in the frame');
});

test('a very long name is shrunk to fit inside the panel, not cut off', async () => {
  const long = { ...employee, first_name: 'TESTBEKJONOVICHEXAMPLOVZODAXON', american_name: 'Bartholomew Maximilian Example' };
  const card = await renderBirthdayCard(long, null);
  // The panel's red edges at the name line stay red: nothing was drawn over them.
  assert.ok(near(await pixel(card, 1060, 870), [157, 35, 33], 40));
  assert.ok(near(await pixel(card, 20, 870), [157, 35, 33], 40));
});

test('a name too wide even at the smallest size is squeezed to fit, never refused', async () => {
  const wide = { ...employee, american_name: 'W'.repeat(80) };
  const card = await renderBirthdayCard(wide, null);
  const meta = await sharp(card).metadata();
  assert.deepEqual([meta.width, meta.height], [1080, 1080]);
  assert.ok(near(await pixel(card, 1060, 940), [157, 35, 33], 40));
});
