'use strict';

/**
 * Asking a model what Safety decided, and keeping only what the messages prove.
 *
 * The model is here for the LANGUAGE: "We cah hire him" (a typo), "good to
 * go", "cleared", "can't take him, 3 accidents". It is also shown the post's
 * pictures, so it can say which one is a candidate's CDL and read a name off
 * it when the recruiter typed none. Everything it says is then cut down by
 * lib/safetyApprovals/reading.js, which is where the safety lives — not here.
 *
 * Both the post and the reply are fenced as untrusted data: anybody in the
 * recruiting group can write "ignore the above" into a message.
 *
 * `AiUnavailableError` (no provider, the capability switched off, every
 * provider failing) is re-thrown so the queue waits and tries again; anything
 * else the model answers that cannot be used is "nothing decided".
 *
 * PICTURES NEED A VISION MODEL (the router sends image parts to Gemini only).
 * When none has answered for a while, the caller may ask for the words alone
 * (`textOnlyFallback`): the decision is still read and still verified, and
 * the post goes out without the CDL file rather than not at all.
 */

const { AiUnavailableError, runCapability } = require('../ai/router');
const { prepareImagePartForAi } = require('../aiImagePrep');
const { verifyReading } = require('../../lib/safetyApprovals/reading');

const CAPABILITY = 'safety_approval_reading';

const SYSTEM = [
  'You read a trucking company\'s recruiting group chat.',
  'A recruiter posted a driver candidate, or a team of two drivers, with photos of documents',
  '(CDL front and back, medical card) and usually the names and phone numbers as text.',
  'A Safety officer REPLIED to that post. Report who the candidates are and what Safety decided.',
  '',
  'Rules:',
  '- Only Safety\'s words decide. The recruiter\'s post never decides anything.',
  '- Safety writes fast and makes typos ("We cah hire" means "We can hire").',
  '- "approved": Safety clearly says the company can hire / approves / cleared / good to go.',
  '- "not_approved": Safety clearly refuses: cannot hire, not approved, denied, disqualified.',
  '- "unclear": a question, a condition, "still checking", "need more documents", or anything',
  '  you are not sure about. When in doubt, it is unclear.',
  '- In a team, decide only for the driver(s) Safety names, unless Safety clearly says both/them.',
  '- Names and phone numbers exactly as written in the post, or as printed on the CDL photo.',
  '- cdl_photo: the index of the photo showing the FRONT of that candidate\'s CDL (driver\'s',
  '  license with the face photo), or null if there is none.',
  '',
  'Answer with JSON only:',
  '{"candidates":[{"name":"First Last","phone":"as written or null","cdl_photo":0}],',
  ' "decisions":[{"name":"First Last","decision":"approved|not_approved|unclear","evidence":"short quote of Safety"}]}',
].join('\n');

function fence(tag, text) {
  return `<${tag}>\n${String(text || '').replace(new RegExp(`</?${tag}>`, 'gi'), '')}\n</${tag}>`;
}

function buildPrompt({ postText, safetyText, fileNames, photoCount }) {
  return [
    fence('recruiter_post', postText || '(no text, photos only)'),
    fence('safety_reply', safetyText),
    fence('safety_file_names', (fileNames || []).join('\n') || '(none)'),
    photoCount
      ? `${photoCount} photo(s) from the recruiter's post follow, each labelled with its index.`
      : 'The post has no photos.',
  ].join('\n\n');
}

/** A shape check only; the content check is verifyReading. */
function validateShape(_text, parsed) {
  if (!parsed || typeof parsed !== 'object') return { message: 'not a JSON object' };
  if (!Array.isArray(parsed.candidates) || !Array.isArray(parsed.decisions)) {
    return { message: 'candidates and decisions must be arrays' };
  }
  return true;
}

/**
 * @param {object} args
 * @param {string} args.postText
 * @param {string} args.safetyText
 * @param {string[]} args.fileNames
 * @param {{buffer: Buffer, mimeType: string}[]} args.images   in index order
 * @returns {Promise<{candidates, decisions, dropped, provider, model}>}
 * @throws {AiUnavailableError} when no model could be asked
 */
async function readSafetyReply({
  postText, safetyText, fileNames = [], images = [], textOnlyFallback = false,
}, deps = {}) {
  try {
    return await readOnce({ postText, safetyText, fileNames, images }, deps);
  } catch (err) {
    if (!(err instanceof AiUnavailableError) || !textOnlyFallback || !images.length) throw err;
    const reading = await readOnce({ postText, safetyText, fileNames, images: [] }, deps);
    return { ...reading, withoutPhotos: true };
  }
}

async function readOnce({ postText, safetyText, fileNames, images }, deps) {
  const run = deps.runCapability || runCapability;
  const prepare = deps.prepareImagePart || prepareImagePartForAi;

  const extraParts = [];
  for (let i = 0; i < images.length; i += 1) {
    extraParts.push({ text: `Photo ${i}:` });
    // eslint-disable-next-line no-await-in-loop
    extraParts.push(await prepare(images[i].buffer, images[i].mimeType));
  }

  const answer = await run({
    capability: CAPABILITY,
    systemText: SYSTEM,
    userText: buildPrompt({ postText, safetyText, fileNames, photoCount: images.length }),
    extraParts: extraParts.length ? extraParts : null,
    expects: 'json',
    validate: validateShape,
    // Still not sure after Claude: the owner is asked, and the answer is a
    // lesson for the next reading (services/ai/learning).
    learning: {
      context: `Safety replied "${String(safetyText || '').slice(0, 300)}" to a recruiter's post: `
        + `"${String(postText || '(photos only)').slice(0, 150)}"`,
      ask: 'What did Safety decide here (approved or not approved), and how should I read replies like this?',
    },
  });

  // Not sure even after Claude (services/ai/escalation.js): no decision — the
  // reply is unclear and Safety is asked, never guessed for.
  const verified = verifyReading(answer?.uncertain ? null : (answer?.parsed ?? null), {
    postText, safetyText, fileNames, photoCount: images.length,
  });
  return { ...verified, provider: answer?.provider ?? null, model: answer?.model ?? null };
}

module.exports = {
  CAPABILITY,
  SYSTEM,
  buildPrompt,
  validateShape,
  readSafetyReply,
  AiUnavailableError,
};
