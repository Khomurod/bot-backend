'use strict';

/**
 * Asking a vision model what is printed on a candidate's CDL — capability
 * `hiring_cdl_reading` (owner, 14 November 2026;
 * docs/architecture/hiring-cdl-reading.md).
 *
 *   WHO MAY READ IT is the owner's: only the providers chosen for this task
 *     in Settings → AI, in that order (lib/ai/providerChoice.js, honoured by
 *     services/ai/router.js); none chosen, or the task switched off, and
 *     nothing is read. A model that cannot see a picture is never asked
 *     (lib/ai/vision.js). An unsure answer is passed to the next chosen
 *     provider; still unsure, and it reads as `unsure` — nothing is written.
 *   WHAT LEAVES: the post's photos only — downloaded by their Telegram file
 *     ids, IN MEMORY (services/telegram/fileDownload.js, the helper Safety
 *     Approvals uses), shrunk like every other picture
 *     (services/aiImagePrep.js) and never stored. No message text, no phone.
 *   WHAT COMES BACK is checked item by item (lib/hiringStages/cdlFields.js);
 *     a value that does not fit its type is dropped, never repaired.
 *
 * Never throws: a failure is `unreadable`, and nothing about it — no value,
 * no model output — is logged or kept.
 */

const { AiUnavailableError, runCapability } = require('../ai/router');
const { getRoster } = require('../ai/registry');
const { isCapabilityEnabled } = require('../ai/capabilityGate');
const { providerOrderFor } = require('../ai/capabilityProviders');
const { prepareImagePartForAi } = require('../aiImagePrep');
const { isVisionModel } = require('../../lib/ai/vision');
const { ANSWER_SHAPE, readCdlAnswer } = require('../../lib/hiringStages/cdlFields');

const CAPABILITY = 'hiring_cdl_reading';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const SYSTEM = [
  'You read photos a recruiter posted in a trucking company\'s recruiting group: a driver candidate\'s',
  'driver\'s licence (CDL), front and back, and sometimes other documents such as a medical card.',
  'Find the CDL, say which photo NUMBER shows its front and which its back, and copy what is PRINTED on it.',
  '',
  'Rules:',
  '- Copy only what is printed on the CDL and legible. Never guess, never complete a value, never take a',
  '  value from another document. An item you cannot read, or that is not on the card: null.',
  '- No photo shows a driver\'s licence: "is_cdl": false.',
  '- The photos show more than one person\'s licence, or you cannot read the CDL with confidence:',
  '  "unclear": true.',
  '- Dates as YYYY-MM-DD: date_of_birth (DOB), issue_date (ISS), expiration_date (EXP).',
  '- first_name, middle_name, last_name and suffix (JR, SR, II, III, IV) separately.',
  '- address_street (number, street, apartment), address_city, address_state (two letters),',
  '  address_zip (5 or 9 digits).',
  '- license_number exactly as printed (letters, digits, dashes); license_state: the issuing state,',
  '  two letters; license_class: A, B, C or as printed.',
  '- endorsements and restrictions: the codes as printed ("H N T", "NONE").',
  '- sex: M, F or X. height as printed (5\'-10"). weight as printed (180 lb).',
  '  eye_color and hair_color as printed (BRO, BLK, BLU).',
  '',
  'Answer with JSON only, exactly this shape (every "fields" value a string or null):',
  JSON.stringify(ANSWER_SHAPE),
  'with "confidence": 0-100, how sure you are of the whole reading.',
].join('\n');

/** The router's check: one object, its fields an object — a malformed answer goes to the next provider. */
function validateShape(_text, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { message: 'not a JSON object' };
  if (parsed.unclear === true || parsed.is_cdl === false) return true;
  if (!parsed.fields || typeof parsed.fields !== 'object' || Array.isArray(parsed.fields)) {
    return { message: 'fields must be an object' };
  }
  return true;
}

/**
 * May a CDL be read right now? `off` (AI or this task switched off),
 * `no_provider` (none chosen — or none of those chosen could be asked at all:
 * switched off, no key, paid while "Free tiers only" is on, or no model that
 * can see a picture) or `ready`. A provider cooling down is still `ready`:
 * that passes, and the read says it could not be done.
 */
async function cdlReadiness() {
  const roster = await getRoster();
  if (roster?.settings?.enabled === false) return 'off';
  if (!(await isCapabilityEnabled(CAPABILITY))) return 'off';
  const order = await providerOrderFor(CAPABILITY);
  if (!Array.isArray(order)) return 'ready';
  const freeOnly = roster?.settings?.freeOnlyMode === true;
  const askable = (roster?.providers || []).filter((p) => order.includes(p.providerKey)
    && p.enabled === true && Boolean(p.apiKey) && (!freeOnly || p.isFree === true)
    && (p.modelChain || []).some((m) => isVisionModel(p.adapter, m)));
  return askable.length ? 'ready' : 'no_provider';
}

async function providerLabelOf(providerKey) {
  try {
    const roster = await getRoster();
    return roster.providers.find((p) => p.providerKey === providerKey)?.label || providerKey;
  } catch {
    return providerKey;
  }
}

/** The post's pictures, in order; one that will not download, or is too large, is left out. */
async function fetchPhotos(images, download) {
  const photos = [];
  for (const image of images) {
    if (image.size && image.size > MAX_IMAGE_BYTES) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      photos.push({ buffer: await download(image.fileId, { maxBytes: MAX_IMAGE_BYTES }), mimeType: image.mimeType });
    } catch (err) {
      console.warn(`[HIRING STAGES] a photo of the post would not download (${err?.kind || err?.name || 'error'})`);
    }
  }
  return photos;
}

/**
 * @param {{images: object[]}} post   the post's images (lib/safetyApprovals/bundle.js shape)
 * @param {object} deps  { download (required), runCapability?, prepareImagePart?, readiness?, today?, providerLabel? }
 * @returns {Promise<{status: 'read', values: object, front: number, back: number|null, providerKey, model,
 *   providerLabel} | {status: 'off'|'no_provider'|'no_photo'|'unreadable'|'unsure', providerKey?, model?, providerLabel?}>}
 */
async function readCdl({ images = [] }, deps = {}) {
  try {
    const readiness = await (deps.readiness || cdlReadiness)();
    if (readiness !== 'ready') return { status: readiness };
    if (!images.length) return { status: 'no_photo' };
    const photos = await fetchPhotos(images, deps.download);
    if (!photos.length) return { status: 'unreadable' };

    const prepare = deps.prepareImagePart || prepareImagePartForAi;
    const extraParts = [];
    for (let i = 0; i < photos.length; i += 1) {
      extraParts.push({ text: `Photo ${i + 1}:` });
      // eslint-disable-next-line no-await-in-loop
      extraParts.push(await prepare(photos[i].buffer, photos[i].mimeType));
    }
    const answer = await (deps.runCapability || runCapability)({
      capability: CAPABILITY,
      systemText: SYSTEM,
      userText: `${photos.length} photo(s) from the recruiter's post follow, each labelled with its number.`,
      extraParts,
      expects: 'json',
      validate: validateShape,
      generation: { temperature: 0, maxTokens: 1500 },
    });
    const by = {
      providerKey: answer.provider || null,
      model: answer.model || null,
      providerLabel: await (deps.providerLabel || providerLabelOf)(answer.provider),
    };
    // Still not sure after the chosen providers (ai-decisions.md rule 7): nothing is written.
    if (answer.uncertain) return { status: 'unsure', ...by };
    const today = deps.today || new Date().toISOString().slice(0, 10);
    const reading = readCdlAnswer(answer.parsed, { photoCount: photos.length, today });
    if (reading.status === 'unsure') return { status: 'unsure', ...by };
    if (reading.status !== 'read') return { status: 'unreadable', ...by };
    return {
      status: 'read', values: reading.values, front: reading.front, back: reading.back, ...by,
    };
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) {
      console.warn(`[HIRING STAGES] the CDL could not be read (${err?.name || 'error'})`);
    }
    return { status: 'unreadable' };
  }
}

module.exports = {
  CAPABILITY, SYSTEM, validateShape, cdlReadiness, readCdl,
};
