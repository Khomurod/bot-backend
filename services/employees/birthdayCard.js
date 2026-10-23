'use strict';

/**
 * Draws an employee's birthday card: the company's own template (owner,
 * 23 October 2026) with the employee's photo in the frame, their full first
 * name in white and their American name in grey under it.
 *
 *   assets/birthday/card-background.jpg   the template with the frame and the
 *                                         name lines cleared — logo, "Happy
 *                                         Birthday" and "WENZE TEAM" stay
 *   assets/fonts/LiberationSerif-Bold.ttf the names (SIL OFL; licence beside it)
 *
 * The production image has no system fonts, so the font is handed to Pango by
 * FILE, never by family name alone.
 *
 * No photo yet: the frame shows the employee's initials, so a missing photo
 * never stops a birthday from being posted.
 *
 * Photos are never in the repository; they live in `employee_photos`.
 * See docs/architecture/employee-birthday-cards.md.
 */
const path = require('node:path');
const sharp = require('sharp');
const { cardFirstName, cardAmericanName, initials } = require('./birthdayText');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const BACKGROUND = path.join(ASSETS, 'birthday', 'card-background.jpg');
const FONT_FILE = path.join(ASSETS, 'fonts', 'LiberationSerif-Bold.ttf');
const FONT_FAMILY = 'Liberation Serif Bold';

// Measured on the template (1080 × 1080).
const CENTRE_X = 545;
const FRAME = { left: 301, top: 325, size: 489 };
const FIRST_NAME = { top: 846, size: 58, color: '#fcffff' };
const AMERICAN_NAME = { top: 921, size: 58, color: '#b4b6b8' };
const MAX_NAME_WIDTH = 760;
const MIN_POINTS = 24;
const STORED_PHOTO_SIZE = 800;

function escapeMarkup(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One line of text as a transparent PNG, shrunk until it fits MAX_NAME_WIDTH. */
async function textLayer(text, { size, color }) {
  let points = size;
  for (;;) {
    const { data, info } = await sharp({
      text: {
        text: `<span foreground="${color}">${escapeMarkup(text)}</span>`,
        font: `${FONT_FAMILY} ${points}`,
        fontfile: FONT_FILE,
        dpi: 72,
        rgba: true,
      },
    }).png().toBuffer({ resolveWithObject: true });
    if (info.width <= MAX_NAME_WIDTH) return { input: data, width: info.width };
    if (points <= MIN_POINTS) {
      // Still too wide at the smallest size: squeeze the image itself, since a
      // layer wider than the card is refused outright and the card never posts.
      const input = await sharp(data).resize({ width: MAX_NAME_WIDTH }).png().toBuffer();
      return { input, width: MAX_NAME_WIDTH };
    }
    points = Math.max(MIN_POINTS, Math.floor(points * (MAX_NAME_WIDTH / info.width)));
  }
}

/**
 * A square crop of a portrait, keeping the face: centred across, and 30% of
 * the spare height above the crop, so a tall photo keeps the head, not the belt.
 */
async function squarePhoto(buffer, size) {
  const image = sharp(buffer, { failOn: 'error' }).rotate();
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  const side = Math.min(info.width, info.height);
  const left = Math.floor((info.width - side) / 2);
  const top = Math.floor((info.height - side) * 0.3);
  return sharp(data)
    .extract({ left, top, width: side, height: side })
    .resize(size, size)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** An uploaded photo, as stored: a square JPEG of a fixed size. Throws on a file that is not an image. */
function normalisePhoto(buffer) {
  return squarePhoto(buffer, STORED_PHOTO_SIZE);
}

function frameSvg({ withPlaceholder }) {
  const { left, top, size } = FRAME;
  const placeholder = withPlaceholder
    ? `<rect x="${left + 1}" y="${top + 1}" width="${size - 2}" height="${size - 2}" fill="#14376a"/>`
    : '';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
      <filter id="s" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="6"/></filter>
      <rect x="${left + 4}" y="${top + 6}" width="${size}" height="${size}" fill="#000" fill-opacity="0.43" filter="url(#s)"/>
      <rect x="${left}" y="${top}" width="${size}" height="${size}" fill="#f6fbff"/>
      ${placeholder}
    </svg>`
  );
}

/**
 * @param {object} employee  { first_name, last_name, american_name }
 * @param {Buffer|null} photo  the stored photo, or null
 * @returns {Promise<Buffer>} a 1080 × 1080 JPEG
 */
async function renderBirthdayCard(employee, photo = null) {
  const layers = [{ input: frameSvg({ withPlaceholder: !photo }), left: 0, top: 0 }];
  const inner = FRAME.size - 2;
  if (photo) {
    layers.push({ input: await squarePhoto(photo, inner), left: FRAME.left + 1, top: FRAME.top + 1 });
  } else {
    const mark = await textLayer(initials(employee), { size: 170, color: '#fcffff' });
    const { height } = await sharp(mark.input).metadata();
    layers.push({
      input: mark.input,
      left: Math.round(FRAME.left + FRAME.size / 2 - mark.width / 2),
      top: Math.round(FRAME.top + FRAME.size / 2 - height / 2),
    });
  }

  const lines = [[cardFirstName(employee), FIRST_NAME], [cardAmericanName(employee), AMERICAN_NAME]];
  for (const [text, style] of lines) {
    if (!text) continue;
    const layer = await textLayer(text, style);
    layers.push({ input: layer.input, left: Math.round(CENTRE_X - layer.width / 2), top: style.top });
  }

  return sharp(BACKGROUND).composite(layers).jpeg({ quality: 92 }).toBuffer();
}

module.exports = { renderBirthdayCard, normalisePhoto, STORED_PHOTO_SIZE };
