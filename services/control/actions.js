'use strict';

/**
 * The ONLY thing in the control channel that changes anything.
 *
 * Everything upstream of this file reads: a Telegram update, an allow-list, a
 * notice row, a parsed intent. This is where a sentence typed into a group chat
 * turns into a correction on the fleet, so the whole file is written around one
 * rule:
 *
 *   AN ACTION MUST BE ONE THE QUESTION OFFERED.
 *
 * Not one the words imply, not one that "obviously" follows — one of the keys
 * in the notice's own `offeredActions`, written by Wenze when it asked. The
 * question is the contract; the reply chooses from it. That is what stops a
 * sentence in a chat from naming an operation, and it is checked here, at the
 * writer, rather than only in the parser — a second reader of the same rule is
 * the point, not a duplication.
 *
 * WHAT THIS FILE MAY REACH, deliberately a closed list: the correction
 * registry, the findings store, and the decision journal. No filesystem, no
 * process, no network, no source code. `tests/controlNoCodeAccess.test.js`
 * asserts the absence structurally, so a later edit that adds `child_process`
 * to any control module fails a test rather than passing review.
 */
const defaultApply = require('../operations/corrections/apply');
const defaultFindings = require('../../database/operationalFindings');
const { payloadFor } = require('../operations/corrections/autoApply');
const { actionForCheck, choiceActionFor, getAction } = require('../operations/corrections/actions');
const { correctionFor, describeChange } = require('../../lib/control/changeCatalogue');
const { sourcesFor, MIN_CONFIDENCE } = require('../operations/corrections/decisionSeam');
const { takeDecision } = require('../decisions/journal');

/** A dismissal with no reason is a decision nobody can review later. */
const DEFAULT_DISMISS_REASON = 'The owner said no in the notification group.';

/**
 * When the change could not be made because the records moved. HONEST about
 * what is known: production, 2026-10-07, this said "Somebody fixed it first"
 * after an action refused for its own reasons with nobody else involved.
 */
const STALE_MESSAGE = 'Nothing changed — the records no longer match what I asked about, '
  + 'so I left them alone. It stays on Needs Attention.';

function defaultDeps() {
  return {
    applyCorrection: defaultApply.applyCorrection,
    StaleCorrectionError: defaultApply.StaleCorrectionError,
    findings: defaultFindings,
    takeDecision,
    payloadFor,
    actionForCheck,
    choiceActionFor,
    getAction,
  };
}

/** How long a finding answered by a typed change waits for the sweep to say whether the change settled it. */
const SETTLE_HOURS = 2;

function offeredEntry(question, actionKey) {
  const offered = Array.isArray(question?.offeredActions) ? question.offeredActions : [];
  return offered.find((o) => o && o.key === actionKey) || null;
}

function isOffered(question, actionKey) {
  return Boolean(offeredEntry(question, actionKey));
}

/**
 * What a chosen answer does: the action and its arguments.
 *
 * A CHOICE CARRIES A VALUE ("working" → active) that the QUESTION wrote, never
 * the reply — the reply only picked which offered entry. The value goes to the
 * action registered for that check's choices, which validates it again.
 */
function resolveChange(deps, finding, actionKey, chosen) {
  // A CHANGE THE OWNER TYPED AND THEN CONFIRMED (`confirmChange.js`). The change
  // is the one stored on the question's own Yes — what the owner read — and it
  // is validated against the catalogue again here, not trusted.
  if (chosen && chosen.change) {
    const correction = correctionFor(chosen.change);
    const action = correction ? deps.getAction?.(correction.actionKey) : null;
    if (!action) return { refused: 'I can no longer make that change.' };
    return {
      action, payload: correction.payload, typed: true, said: describeChange(chosen.change),
    };
  }
  if (chosen && chosen.value != null) {
    const choice = deps.choiceActionFor?.(finding.checkKey);
    if (!choice) return { refused: 'There is nothing for me to change on that one.' };
    const payload = choice.payload(finding, chosen.value);
    if (!payload) return { refused: 'I no longer have what I would need to make that change.' };
    return { action: choice.action, payload };
  }
  if (actionKey !== 'approve') return { refused: 'That is not one of the answers to this question.' };
  const action = deps.actionForCheck(finding.checkKey);
  if (!action) return { refused: 'There is nothing for me to change on that one.' };
  const payload = deps.payloadFor(finding);
  if (!payload) return { refused: 'I no longer have what I would need to make that change.' };
  return { action, payload };
}

/**
 * Carry out what the reply chose.
 *
 * @param {object} args
 * @param {object} args.question   the notice's `question_json`
 * @param {object} args.finding    the finding, re-read live (never the one the
 *                                 question was composed from — minutes have
 *                                 passed and somebody may have fixed it)
 * @param {object} args.intent     from `lib/control/intent.js`
 * @param {string} args.telegramUserId  who is answering
 * @returns {Promise<{outcome:string, message:string, correctionId?:number|null,
 *   decisionId?:number|null}>}  never throws
 */
async function executeOffered({
  question, finding, intent, telegramUserId,
}, deps = defaultDeps()) {
  const actionKey = intent?.action || null;
  const chosen = offeredEntry(question, actionKey);

  if (!actionKey || !chosen) {
    return { outcome: 'refused', message: 'That is not one of the answers to this question.' };
  }

  if (actionKey === 'snooze') {
    const hours = Math.max(1, Math.min(720, Number(intent.snoozeHours) || 24));
    const until = new Date(Date.now() + hours * 3600_000);
    await deps.findings.snoozeFinding(finding.id, until);
    return {
      outcome: 'snoozed',
      message: `Put aside. I will bring it up again in ${hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`}.`,
    };
  }

  // "No" TO "DID I UNDERSTAND YOU RIGHT?" — nothing changes and the original
  // question stays open. It is not a dismissal of the finding.
  if (actionKey === 'dismiss' && chosen.rejectsChange) {
    return {
      outcome: 'no_op',
      message: 'Then I change nothing. The question stays open — tell me again in other words, or answer it in the admin.',
    };
  }

  if (actionKey === 'dismiss') {
    const reason = intent.reason || chosen.reason || DEFAULT_DISMISS_REASON;
    const dismissed = await deps.findings.dismissFinding(finding.id, {
      dismissedBy: `telegram:${telegramUserId}`,
      reason,
    });
    if (!dismissed) {
      return { outcome: 'no_op', message: 'Somebody had already closed that one.' };
    }
    return { outcome: 'dismissed', message: 'Closed. I will not raise it again.' };
  }

  // ── approve, or another offered answer ────────────────────────────────────
  const change = resolveChange(deps, finding, actionKey, chosen);
  if (change.refused) return { outcome: 'refused', message: change.refused };
  const { action, payload, typed } = change;

  // THE JOURNAL FIRST, THE CHANGE SECOND. A decision records what was decided
  // and on what evidence, and it must exist whether or not the change then
  // succeeds — a correction with no decision behind it is exactly the hole the
  // decision spine was built to close. The mode is `suggest`, honestly: the
  // check is NOT in autopilot, a person approved this one instance.
  const decision = await deps.takeDecision({
    checkKey: finding.checkKey,
    subjectType: finding.subjectType,
    subjectId: finding.subjectId,
    personId: finding.evidence?.personId ?? null,
    sources: sourcesFor(finding),
    confidence: finding.confidence,
    minConfidence: MIN_CONFIDENCE,
    mode: 'suggest',
    shadow: false,
    evidence: {
      findingId: finding.id,
      actionKey: action.key,
      title: finding.title,
      severity: finding.severity,
      approvedVia: 'telegram',
      ...(chosen.value != null ? { chosenValue: chosen.value } : {}),
      ...(typed ? { typedChange: chosen.change } : {}),
    },
  });

  try {
    const correction = await deps.applyCorrection({
      actionKey: action.key,
      payload,
      finding,
      // A PERSON, NOT THE SYSTEM. `initiatorFor` turns this into
      // `telegram:<id>`, which is what lets an approval-tier action past the
      // schema's system-is-auto-only CHECK.
      admin: { telegramUserId: String(telegramUserId) },
      reason: typed ? `Confirmed in the notification group: ${change.said}` : 'Approved in the notification group.',
      // A typed change answers the finding but may not settle it: the next sweep
      // says, so the finding is put aside for a while rather than marked applied.
      markFinding: !typed,
    });
    await decision?.acted?.(action.key, correction?.id ?? null);
    if (typed) {
      await deps.findings.snoozeFinding(finding.id, new Date(Date.now() + SETTLE_HOURS * 3600_000)).catch(() => {});
      return {
        outcome: 'applied',
        message: `Done — ${change.said}. If that does not settle it, I will ask again after the next check.`,
        correctionId: correction?.id ?? null,
        decisionId: decision?.id ?? null,
      };
    }
    return {
      outcome: 'applied',
      message: chosen.value != null && chosen.label ? `Done — recorded as ${chosen.label}.` : 'Done.',
      correctionId: correction?.id ?? null,
      decisionId: decision?.id ?? null,
    };
  } catch (err) {
    if (err instanceof deps.StaleCorrectionError || err?.name === 'StaleCorrectionError') {
      return {
        outcome: 'no_op',
        message: err.plain || STALE_MESSAGE,
        decisionId: decision?.id ?? null,
      };
    }
    return {
      outcome: 'failed',
      message: 'I could not make that change. It is recorded and still open.',
      decisionId: decision?.id ?? null,
    };
  }
}

module.exports = {
  DEFAULT_DISMISS_REASON, STALE_MESSAGE, isOffered, executeOffered, defaultDeps,
};
