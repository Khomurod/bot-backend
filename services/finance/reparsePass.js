'use strict';

/**
 * Re-reading what an older parser misunderstood.
 *
 * WHY THIS HAS TO EXIST. Every captured row records the parser version that
 * read it, so a tightened parser can go back over exactly the rows the old one
 * produced — including the ones it got wrong. Without that pass, a version bump
 * leaves the table holding a silent mix of two vocabularies: messages captured
 * last week say `not_moneycode` because version 1 had never heard of "Money
 * Transfer code", and nothing would ever revisit them. The money in them would
 * simply never appear.
 *
 * IT RE-READS. IT DOES NOT RE-INVENT. Each message goes back through the same
 * `reparseCapturedMessage` a person's Re-read button uses, which re-runs the
 * current parser over the STORED TEXT and records the code through the same
 * duplicate decision a live capture uses. No row is created from anything but a
 * message that was already captured, and `ON CONFLICT (message_ref_id,
 * code_normalized) DO NOTHING` means running this twice cannot produce a second
 * money-code row for the same reading.
 *
 * IT IS BOUNDED, AND IT FINISHES. A few at a time, oldest first, every pass —
 * so a backlog drains over several ticks instead of rewriting a payments table
 * in one sweep, and a pass that finds nothing left costs one indexed count.
 */

const { PARSER_VERSION, STATUS } = require('../../lib/finance/moneycode');
const financeMessages = require('../../database/financeMessages');
const lifecycle = require('../../database/financeMoneycodeLifecycle');
const { reparseCapturedMessage } = require('./captureService');
const { interpretMessage } = require('./aiInterpret');
const { AI_KIND } = require('../../lib/finance/aiReading');

/** How many messages one pass will re-read. */
const MAX_PER_PASS = 25;

/**
 * How many a model is offered per pass.
 *
 * Much smaller than the re-read batch on purpose: a re-read is a regex over
 * stored text and a model call is a network round trip somebody pays for. The
 * backlog drains over several passes rather than in one expensive burst.
 */
const MAX_AI_PER_PASS = 5;

/**
 * The confidence an AI reading needs before it is worth recording at all.
 * Below this the message simply stays where it is, for a person.
 */
const MIN_AI_CONFIDENCE = 70;

function defaultDeps() {
  return {
    messages: financeMessages,
    reparse: reparseCapturedMessage,
    lifecycle,
    interpret: interpretMessage,
  };
}

/** Which kinds are worth a person's time once a model has read them. */
const NEEDS_A_PERSON = Object.freeze([
  AI_KIND.ISSUE, AI_KIND.VOID_COMPLETED, AI_KIND.REPLACEMENT,
]);

/**
 * Store the verified reading beside the message, and move it where somebody
 * will see it.
 *
 * An ISSUE reading is the sharpest case: the model says this message issued a
 * code, and the code is verified to be in the text — but a money row written
 * from a model's reading is exactly the thing `docs/brief/invariants.md`
 * forbids, so the MESSAGE is flagged and a person records it. `unrelated` and
 * `unclear` keep whatever status the rules gave them; the reading is stored
 * either way, so the call is never invisible.
 */
async function recordReading(row, reading, deps) {
  const detail = {
    kind: 'ai_reading',
    read: reading.kind,
    confidence: reading.confidence,
    code: reading.code,
    amount: reading.amount,
    referencesCode: reading.referencesCode,
    issuedTo: reading.issuedTo,
    dropped: reading.dropped,
  };
  const status = NEEDS_A_PERSON.includes(reading.kind) ? STATUS.NEEDS_REVIEW : row.parseStatus;
  await deps.messages.setMessageStatus(row.id, status, detail);
}

/**
 * Offer the messages the rules could not settle to a model.
 *
 * THE SAFETY LINE IS HERE, and it is narrower than what the model is allowed to
 * SAY. A verified reading can move a message off the unclear pile and can mark
 * a code as wanting a person — it can never void one. Voiding is an automatic
 * action against money, and `docs/brief/invariants.md` is explicit that AI may
 * interpret evidence and must not manufacture the evidence an automatic action
 * needs. So an AI-read void becomes `needs_review` on the code it names, with
 * the reading stored, and a person finishes it.
 *
 * IT RUNS HERE RATHER THAN IN CAPTURE because capture sits inside Telegram's
 * message pipeline: a model call there would hold that pipeline open on every
 * finance message, which is the same reason documents are queued rather than
 * downloaded inline.
 */
async function offerToModel(summary, deps) {
  const waiting = await deps.messages.listMessagesAwaitingAiReading({ limit: MAX_AI_PER_PASS });
  for (const row of waiting) {
    let out;
    try {
      // eslint-disable-next-line no-await-in-loop
      out = await deps.interpret({ text: row.text, status: row.parseStatus });
    } catch (err) {
      summary.errors.push(`ai ${row.id}: ${err.message}`);
      continue;
    }

    // No provider, capability off, or a refused reading: the attempt is NOT
    // burned when nothing answered, so a cooldown does not cost the message its
    // one chance.
    if (!out.used) {
      if (/no reading available|switched off/.test(String(out.reason || ''))) continue;
      // eslint-disable-next-line no-await-in-loop
      await deps.messages.markAiRead(row.id);
      summary.aiRefused += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await deps.messages.markAiRead(row.id);
    summary.aiRead += 1;

    const reading = out.reading;
    if (reading.confidence < MIN_AI_CONFIDENCE) continue;

    // THE READING IS WRITTEN DOWN BEFORE ANYTHING ELSE HAPPENS TO IT. The
    // attempt has just been spent and a message gets exactly one, so a reading
    // that was paid for and then discarded is a message left on the unclear
    // pile with nothing to show for the call — which was true for four of the
    // six kinds a model may return. This stores what was read and moves the
    // message to the pile a person works through; it records no money, no
    // state on any code, and nothing the verifier did not confirm is in the
    // text.
    // eslint-disable-next-line no-await-in-loop
    await recordReading(row, reading, deps);

    if (reading.kind === AI_KIND.VOID_COMPLETED && reading.referencesCode) {
      // eslint-disable-next-line no-await-in-loop
      const code = await deps.lifecycle.findCodeByDigits(reading.referencesCode);
      if (!code) continue;
      // eslint-disable-next-line no-await-in-loop
      const marked = await deps.lifecycle.markNeedsReview(
        code.id,
        'a model read a message as voiding this code — a person confirms it',
        {
          messageRefId: row.id,
          decidedBy: 'ai',
          evidence: { kind: 'ai_reading', confidence: reading.confidence, dropped: reading.dropped },
        },
      );
      if (marked.changed) summary.aiFlagged += 1;
      continue;
    }

    if (reading.kind === AI_KIND.REPLACEMENT && reading.referencesCode && reading.code) {
      // eslint-disable-next-line no-await-in-loop
      const replaced = await deps.lifecycle.findCodeByDigits(reading.referencesCode);
      if (!replaced) continue;
      // eslint-disable-next-line no-await-in-loop
      const marked = await deps.lifecycle.markNeedsReview(
        replaced.id,
        `a model read a message as replacing this code with ${reading.code} — a person confirms it`,
        {
          messageRefId: row.id,
          decidedBy: 'ai',
          evidence: { kind: 'ai_replacement', replacementCode: reading.code, confidence: reading.confidence },
        },
      );
      if (marked.changed) summary.aiFlagged += 1;
    }
  }
}

/**
 * One pass over the backlog.
 *
 * @returns a summary for the run ledger: `{ reread, codesRecorded, changed,
 *   remaining, errors, blocked?, error? }`. `blocked` when the tables are not
 *   there at all, which is an unconfigured Finance Monitor rather than a fault.
 */
async function runFinanceReparsePass({ limit = MAX_PER_PASS, deps = defaultDeps() } = {}) {
  const summary = {
    reread: 0, codesRecorded: 0, changed: 0, remaining: null,
    aiRead: 0, aiRefused: 0, aiFlagged: 0, errors: [],
  };

  const remainingBefore = await deps.messages.countStaleParserMessages(PARSER_VERSION);
  if (remainingBefore === null) {
    return { ...summary, blocked: 'the Finance Monitor tables are not there yet' };
  }

  const ids = remainingBefore === 0
    ? []
    : await deps.messages.listStaleParserMessages({ version: PARSER_VERSION, limit });

  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await deps.reparse(id);
      if (!out) continue;
      summary.reread += 1;
      if (out.codeRecorded) summary.codesRecorded += 1;
      if (out.before !== out.after) summary.changed += 1;
    } catch (err) {
      summary.errors.push(`${id}: ${err.message}`);
    }
  }

  summary.remaining = await deps.messages.countStaleParserMessages(PARSER_VERSION);

  // ONLY AFTER THE RULES HAVE HAD THEIR TURN. A message the re-read just
  // settled is not offered to a model, which is what keeps the common case
  // free.
  try {
    await offerToModel(summary, deps);
  } catch (err) {
    summary.errors.push(`ai: ${err.message}`);
  }

  // EVERY MESSAGE IN THE BATCH FAILING is the pass not having run, and
  // `statusFromSummary` reads `error` — singular. One bad row among twenty-five
  // is a row to look at; twenty-five out of twenty-five is a fault.
  if (ids.length && summary.errors.length === ids.length) {
    summary.error = `none of the ${ids.length} message(s) could be re-read`;
  }
  return summary;
}

module.exports = {
  MAX_PER_PASS, MAX_AI_PER_PASS, MIN_AI_CONFIDENCE,
  runFinanceReparsePass, offerToModel, defaultDeps,
};
