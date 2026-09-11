'use strict';

/**
 * Turning an approved knowledge base and a conversation into one safe sentence.
 *
 * The composition half of the after-hours reply, kept apart from the gate
 * sequence in `afterHoursReply.js` so that WHAT Wenze may say can be read, and
 * tested, without the machinery of WHEN it is allowed to say anything.
 *
 * THE GUARD RUNS ON THE MODEL'S OUTPUT AGAINST THE SAME STATEMENTS THE PROMPT
 * WAS BUILT FROM. Running it twice is the point. Telling a model the rules is a
 * request; `lib/recruiting/replyGuard.js` is the enforcement, and "but the
 * prompt said not to" has never once stopped a model that was going to anyway.
 */
const { checkReply } = require('../../lib/recruiting/replyGuard');
const { renderThread } = require('../../lib/recruiting/thread');
const { timeToMinutes } = require('../../lib/recruiting/workingHours');
const { renderForPrompt } = require('./teach');

const CAPABILITY = 'recruiting_after_hours_reply';

/** The one thing Wenze may say with no model and no approved knowledge at all. */
function acknowledgementText({ firstName, nextOpenText }) {
  const hi = firstName ? `Hi ${firstName} — ` : '';
  const when = nextOpenText ? ` ${nextOpenText}` : ' during working hours';
  return `${hi}thanks for your message. Our office is closed right now, `
    + `but a recruiter will get back to you${when}.`;
}

/**
 * "on Monday morning" — a day, never a clock time.
 *
 * The schedule knows the exact minute the office opens and saying it would be a
 * commitment nobody made: a recruiter who starts at 08:00 does not necessarily
 * reach this candidate at 08:00, and a candidate told 8am who hears nothing at
 * 8:15 has been let down by a detail that added nothing.
 */
function describeNextOpen(nextOpenIso, timezone) {
  if (!nextOpenIso) return null;
  try {
    // eslint-disable-next-line global-require
    const { DateTime } = require('luxon');
    const then = DateTime.fromISO(nextOpenIso, { setZone: true }).setZone(timezone);
    if (!then.isValid) return null;
    return `on ${then.toFormat('cccc')} morning`;
  } catch (_) {
    return null;
  }
}

/**
 * Is `localTimeHHMM` inside the do-not-disturb window?
 *
 * Same overnight arithmetic as a working-hours window, and for the same reason:
 * 21:00–08:00 is the normal shape of this setting, so the wrap-around case is
 * the main case rather than an edge one.
 */
function inQuietHours({ quietStartLocal, quietEndLocal }, localTimeHHMM) {
  const now = timeToMinutes(localTimeHHMM);
  const start = timeToMinutes(quietStartLocal);
  const end = timeToMinutes(quietEndLocal);
  if (now === null || start === null || end === null) return false;
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

/**
 * What the model is given.
 *
 * The approved statements are fenced off explicitly rather than merged into the
 * prose, because the instruction that matters — you may state nothing else —
 * needs something to point at.
 */
function buildPrompt({ knowledgeText, threadText, recruiterName, companyName }) {
  return [
    `You are answering an SMS on behalf of ${recruiterName || 'a recruiter'}`,
    `at ${companyName || 'a trucking company'}. The office is closed; you are covering`,
    'so the candidate is not left waiting until morning.',
    '',
    '=== The ONLY information you may state as fact ===',
    knowledgeText,
    '=== end of approved information ===',
    '',
    'The conversation so far:',
    threadText,
    '',
    'Write the next message. Rules, all of them absolute:',
    '- One or two short sentences. Plain text for a phone. No markdown, no emoji, no links.',
    '- You may ONLY state facts from the approved information above. If the candidate',
    '  asks something it does not cover, say the recruiter will confirm it and move on.',
    '- NEVER state a number — pay, miles, bonus, age, years, dates — unless that exact',
    '  number appears in the approved information.',
    '- NEVER promise, guarantee, approve, waive, or make an exception. If they ask for one,',
    '  say the recruiter can discuss it during working hours.',
    '- NEVER say they are hired, accepted or rejected. That is not your decision.',
    '- Sound like a person: warm, brief, and interested. Ask one useful question if it',
    '  moves things forward.',
    '',
    'Answer as JSON: {"reply": "...", "handOff": true|false, "handOffReason": "..."}',
    'Set handOff when they ask for a human, are upset, or ask something you cannot answer',
    'without inventing. handOffReason is one short phrase for the recruiter.',
  ].join('\n');
}

/** Shape only. Whether the words are ALLOWED is replyGuard's job, not this one. */
function validateShape(_text, parsed) {
  if (!parsed || typeof parsed !== 'object') return { message: 'not an object' };
  if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
    return { message: 'no reply text' };
  }
  return true;
}

/** The confirmed statements, and the same statements rendered for a prompt. */
async function loadApprovedKnowledge(deps) {
  try {
    const entries = await deps.knowledge.listActiveKnowledge();
    return { entries: entries || [], text: renderForPrompt(entries || []) };
  } catch (err) {
    console.warn('[RecruitingAfterHours] could not read approved knowledge:', err.message);
    return { entries: [], text: '' };
  }
}

/**
 * Ask a model for the next message, then refuse it if it strayed.
 *
 * `nextOpenText` is handed to the guard as an approved figure because the
 * opening day came from the schedule rather than from the model — the guard
 * cannot tell those apart on its own, and without this a reply that correctly
 * said "on Monday morning" could be refused for a number the system supplied.
 */
async function composeReply({ turns, approved, recruiter, nextOpenText }, deps) {
  let parsed;
  try {
    const result = await deps.runCapability({
      capability: CAPABILITY,
      userText: buildPrompt({
        knowledgeText: approved.text,
        threadText: renderThread(turns),
        recruiterName: recruiter?.name || null,
        companyName: recruiter?.company_name || null,
      }),
      expects: 'json',
      validate: validateShape,
      maxOutputTokens: 300,
    });
    parsed = result?.parsed;
  } catch (err) {
    return { ok: false, reason: 'ai_unavailable', detail: err.message };
  }

  if (validateShape(null, parsed) !== true) return { ok: false, reason: 'ai_bad_shape' };

  const verdict = checkReply(parsed.reply, {
    approvedText: approved.entries.map((e) => e.statement),
    extraApproved: nextOpenText ? [nextOpenText] : [],
  });
  if (!verdict.ok) {
    return {
      ok: false,
      reason: 'refused_by_guard',
      refusal: `${verdict.reason} — ${verdict.detail || ''}`.trim(),
    };
  }

  return {
    ok: true,
    text: verdict.text,
    handOff: parsed.handOff === true,
    handOffReason: typeof parsed.handOffReason === 'string' ? parsed.handOffReason.slice(0, 120) : null,
  };
}

module.exports = {
  CAPABILITY,
  acknowledgementText,
  describeNextOpen,
  inQuietHours,
  buildPrompt,
  validateShape,
  loadApprovedKnowledge,
  composeReply,
};
