'use strict';

/**
 * Turning findings into questions somebody can answer from their phone.
 *
 * THE GAP THIS CLOSES. The sweep files findings and notifies about nothing:
 * every one of them waits in the admin for somebody to go and look. And a check
 * in `suggest` mode never reaches `takeDecision` at all, so the journal has no
 * `suggest` rows — the decision spine records what Wenze DID and is silent
 * about what it wanted to do. This pass is both halves: it asks, and the asking
 * is journalled as the suggestion it is.
 *
 * WHAT IS ASKABLE, and nothing else:
 *   - tier `auto` whose check is in `suggest` mode — Wenze could do it, the
 *     owner has not said it may, so asking is exactly right;
 *   - tier `approval` with a registered action — a person was always required.
 * A `warning`-tier finding is NOT askable: there is nothing to approve, and a
 * question with no action behind it is a notification wearing a question mark.
 *
 * FOUR THINGS KEEP IT FROM BECOMING NOISE, which is the failure mode that would
 * end with the group muted and every question unanswered:
 *   - a hard cap per pass (`max_questions_per_pass`), oldest first;
 *   - the same question is not re-asked inside `repeat_after_hours`;
 *   - a finding that already carries an unanswered question is skipped;
 *   - the wording table is an allow-list — a check with no entry never asks.
 */
const defaultFindings = require('../../database/operationalFindings');
const defaultNotices = require('../../database/operationalNotifications');
const defaultSettings = require('../../database/controlSettings');
const defaultSend = require('../notifications/send');
const { actionForCheck } = require('../operations/corrections/actions');
const { payloadFor, loadCheckSettings } = require('../operations/corrections/autoApply');
const { questionFor, offeredActionsFor, replyHintFor } = require('../../lib/control/askable');
const { sourcesFor, MIN_CONFIDENCE } = require('../operations/corrections/decisionSeam');
const { takeDecision } = require('../decisions/journal');

/** How many open findings to consider per pass before the cap is applied. */
const SCAN_LIMIT = 100;

function defaultDeps() {
  return {
    findings: defaultFindings,
    notices: defaultNotices,
    settings: defaultSettings,
    notify: defaultSend.notify,
    actionForCheck,
    payloadFor,
    loadCheckSettings,
    takeDecision,
  };
}

function modeOf(setting) {
  if (!setting) return null;
  if (setting.mode) return setting.mode;
  return setting.auto_apply_enabled === true ? 'autopilot' : 'suggest';
}

/**
 * The notice-key PREFIX every question about one finding shares.
 *
 * It must be the prefix `notify` actually writes — `noticeKeyFor` joins
 * category, subject type and subject id — because `noticeSentWithin` matches on
 * it with LIKE. A hand-written key that merely looked similar would suppress
 * nothing and the group would be asked the same thing every fifteen minutes.
 */
function questionKeyFor(findingId) {
  // THE TRAILING COLON IS LOAD-BEARING. Without it the prefix for finding 4
  // also matches finding 42's keys, and one finding silently suppresses
  // another's question. Every question carries a round discriminator, so the
  // separator is always there to match against.
  return `needs_attention:control_question:${findingId}:`;
}

/**
 * Which repeat window this finding is in, counted from when it was first seen.
 *
 * THE NOTICE KEY IS UNIQUE, so without a part that changes, the second ask
 * about a finding would be swallowed by the outbox's own dedup — silently,
 * looking exactly like suppression working. One round per `repeat_after_hours`
 * gives a re-ask a key of its own while still being deterministic, so two
 * passes minutes apart compute the same round and do not both ask.
 */
function askRoundFor(finding, repeatAfterHours, now = Date.now()) {
  const first = Date.parse(finding?.firstSeenAt || '');
  const windowMs = Math.max(1, Number(repeatAfterHours) || 72) * 3600_000;
  if (!Number.isFinite(first)) return 0;
  return Math.max(0, Math.floor((now - first) / windowMs));
}

/**
 * Is this finding one to ask about?
 *
 * PURE given its inputs, so the rule can be read in one place and tested
 * without a database.
 */
function isAskableFinding(finding, { mode, hasAction }) {
  if (!finding || finding.status !== 'open') return false;
  if (finding.tier === 'approval') return hasAction;
  if (finding.tier === 'auto') return hasAction && mode === 'suggest';
  return false;
}

/**
 * Ask what can be asked. Never throws.
 *
 * @returns {Promise<{asked:number, considered:number, skipped:object}>}
 */
async function runAskPass(_options = {}, deps = defaultDeps()) {
  const skipped = { notAskable: 0, noWording: 0, recentlyAsked: 0, noPayload: 0, notSent: 0 };
  let asked = 0;

  const settings = await deps.settings.getControlSettings();
  if (settings.enabled === false) {
    return { asked: 0, considered: 0, skipped, reason: 'disabled' };
  }

  // THE STANDING CAP, and it is not the same as the per-pass cap. The per-pass
  // cap limits ONE pass; this sweep runs every fifteen minutes, so without this
  // the first day after a deploy would deliver hundreds of questions into a
  // group that has answered none of them. While the owner is already carrying
  // `max_questions_per_pass` unanswered questions, the pass asks nothing — the
  // queue drains at the speed somebody actually answers it.
  const outstanding = await deps.notices.countUnansweredQuestions(settings.repeatAfterHours)
    .catch(() => Number.MAX_SAFE_INTEGER);
  if (outstanding >= settings.maxQuestionsPerPass) {
    return { asked: 0, considered: 0, skipped, reason: 'waiting_for_answers', outstanding };
  }

  const checkSettings = await deps.loadCheckSettings().catch(() => new Map());
  const open = await deps.findings.listFindings({ status: 'open', limit: SCAN_LIMIT });
  // OLDEST FIRST. A question that has waited three days matters more than one
  // filed four minutes ago, and taking the newest would leave the oldest
  // permanently at the back of a capped queue.
  const candidates = [...open].sort(
    (a, b) => new Date(a.firstSeenAt || 0) - new Date(b.firstSeenAt || 0)
  );

  for (const finding of candidates) {
    if (asked + outstanding >= settings.maxQuestionsPerPass) break;

    const action = deps.actionForCheck(finding.checkKey);
    const mode = modeOf(checkSettings.get?.(finding.checkKey));
    if (!isAskableFinding(finding, { mode, hasAction: Boolean(action) })) {
      skipped.notAskable += 1;
      continue;
    }

    const wording = questionFor(finding);
    if (!wording) { skipped.noWording += 1; continue; }

    const payload = deps.payloadFor(finding);
    if (!payload) { skipped.noPayload += 1; continue; }

    const key = questionKeyFor(finding.id);
    // eslint-disable-next-line no-await-in-loop
    const recently = await deps.notices.noticeSentWithin(key, settings.repeatAfterHours)
      .catch(() => true); // A read that failed must not become a second question.
    if (recently) { skipped.recentlyAsked += 1; continue; }

    const offeredActions = offeredActionsFor({ hasAction: true });

    // THE SUGGESTION IS JOURNALLED BEFORE IT IS ASKED. This is what finally
    // writes `suggest` rows: the pass is saying "I would do this", and that is
    // a decision whether or not anybody answers. `shadow: false` because the
    // question is real; `mode: 'suggest'` because it is, honestly, a suggestion.
    // eslint-disable-next-line no-await-in-loop
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
        findingId: finding.id, actionKey: action.key,
        title: finding.title, severity: finding.severity, askedVia: 'telegram',
      },
    }).catch(() => null);

    // eslint-disable-next-line no-await-in-loop
    const sent = await deps.notify({
      category: 'needs_attention',
      title: wording.ask,
      lines: [...wording.lines, replyHintFor(offeredActions)],
      action: `Ref Q-${finding.id}`,
      subjectType: 'control_question',
      subjectId: String(finding.id),
      discriminator: `r${askRoundFor(finding, settings.repeatAfterHours)}`,
      personId: finding.evidence?.personId ?? null,
      severity: finding.severity,
      findingId: finding.id,
      // WHAT A REPLY MAY CHOOSE FROM. The reply path reads this and nothing
      // else — no action key travels in the visible text, so the words in the
      // chat can never name an operation.
      question: {
        findingId: finding.id,
        decisionId: decision?.id ?? null,
        offeredActions,
        parentNoticeId: null,
      },
    }).catch(() => null);

    if (sent?.recorded) asked += 1;
    else skipped.notSent += 1;
  }

  return { asked, considered: candidates.length, skipped };
}

module.exports = {
  SCAN_LIMIT, questionKeyFor, askRoundFor, isAskableFinding, runAskPass, defaultDeps,
};
