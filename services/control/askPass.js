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
 * FIVE THINGS KEEP IT FROM BECOMING NOISE, which is the failure mode that would
 * end with the group muted and every question unanswered:
 *   - a hard cap per pass (`max_questions_per_pass`), oldest first;
 *   - the same question is not re-asked inside `repeat_after_hours`;
 *   - a finding that already carries an unanswered question is skipped;
 *   - the wording table is an allow-list — a check with no entry never asks;
 *   - a question the owner has ALREADY answered is closed from memory instead
 *     of asked again, and only while the condition is the one they answered
 *     about (`lib/control/fingerprint.js`).
 */
const defaultFindings = require('../../database/operationalFindings');
const defaultNotices = require('../../database/operationalNotifications');
const defaultSettings = require('../../database/controlSettings');
const defaultKnowledge = require('../../database/controlKnowledge');
const defaultDecisions = require('../../database/operationalDecisions');
const defaultSend = require('../notifications/send');
const { actionForCheck } = require('../operations/corrections/actions');
const { payloadFor, loadCheckSettings } = require('../operations/corrections/autoApply');
const { questionFor, offeredActionsFor, replyHintFor } = require('../../lib/control/askable');
const { sourcesFor, MIN_CONFIDENCE } = require('../operations/corrections/decisionSeam');
const { takeDecision } = require('../decisions/journal');
const { memoryApplies, actsFromMemory } = require('../../lib/control/fingerprint');

/** How many open findings to consider per pass before the cap is applied. */
const SCAN_LIMIT = 100;

function defaultDeps() {
  return {
    findings: defaultFindings,
    notices: defaultNotices,
    settings: defaultSettings,
    knowledge: defaultKnowledge,
    decisions: defaultDecisions,
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
function isAskableFinding(finding, { mode, hasAction, held = false }) {
  if (!finding || finding.status !== 'open') return false;
  if (finding.tier === 'approval') return hasAction;
  if (finding.tier === 'auto') {
    // ON AUTOPILOT AND IT DID NOT ACT — the case that used to fall through
    // every gap. A check the owner has permitted decides `hold` or `unknown`,
    // records that honestly in the journal, and stops. The finding stays open,
    // the mode is not `suggest`, so nothing ever asked; it simply sat there.
    // That is the worst of both settings: the owner granted autonomy and got
    // silence. A held decision is precisely the moment to ask a person.
    if (held) return hasAction;
    return hasAction && mode === 'suggest';
  }
  return false;
}

/**
 * Close a finding the owner has already answered, and say so on the memory.
 *
 * ONLY A REMEMBERED "NO" ACTS. `actsFromMemory` is the rule and it lives in the
 * pure module so it can be read without this file's plumbing around it: a
 * remembered approval is recorded and is never re-applied.
 *
 * THE REASON NAMES THE MEMORY. A finding closed here with a bare reason would
 * look, in the admin, exactly like somebody sitting at the screen dismissing
 * it — and the difference (a person decided this once, in a chat, on the 3rd)
 * is the thing anybody reviewing it needs.
 *
 * @returns {Promise<boolean>} true when the finding was closed from memory.
 */
async function applyMemory(finding, deps) {
  // OPTIONAL-CHAINED AND FAIL-OPEN. A dependency map without this read, or a
  // query that failed, must cost the MEMORY, not the question. Asking something
  // twice is a nuisance; closing a finding because a read half-worked is not.
  const memory = await Promise.resolve(deps.knowledge?.findMemory?.({
    checkKey: finding.checkKey,
    subjectType: finding.subjectType,
    subjectId: String(finding.subjectId),
  })).catch(() => null);
  if (!memory) return false;
  if (!actsFromMemory(memory.answerAction)) return false;
  if (!memoryApplies(finding, memory)) return false;

  const said = memory.answerText ? ` "${String(memory.answerText).slice(0, 200)}"` : '';
  const dismissed = await deps.findings.dismissFinding(finding.id, {
    dismissedBy: memory.confirmedBy || 'telegram',
    reason: `Already answered in the notification group${said}.`,
  }).catch(() => null);
  if (!dismissed) return false;

  await Promise.resolve(deps.knowledge?.noteApplied?.(memory.id)).catch(() => {});
  return true;
}

/**
 * Ask what can be asked. Never throws.
 *
 * @returns {Promise<{asked:number, considered:number, skipped:object}>}
 */
async function runAskPass(_options = {}, deps = defaultDeps()) {
  const skipped = {
    notAskable: 0, noWording: 0, recentlyAsked: 0, noPayload: 0, notSent: 0, remembered: 0,
  };
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

  const checkSettings = await deps.loadCheckSettings().catch(() => new Map());
  // WHAT WENZE DECIDED NOT TO DO, and why. Keyed `check|subjectType|subjectId`.
  // Read once per pass rather than per finding: this is a hundred candidates
  // against one query.
  const holds = await Promise.resolve(deps.decisions?.currentHolds?.())
    .catch(() => new Map()) || new Map();
  const open = await deps.findings.listFindings({ status: 'open', limit: SCAN_LIMIT });
  // OLDEST FIRST. A question that has waited three days matters more than one
  // filed four minutes ago, and taking the newest would leave the oldest
  // permanently at the back of a capped queue.
  const candidates = [...open].sort(
    (a, b) => new Date(a.firstSeenAt || 0) - new Date(b.firstSeenAt || 0)
  );

  // ── WHAT HAVE YOU ALREADY ANSWERED? ───────────────────────────────────────
  //
  // A SEPARATE PASS, AND IT RUNS BEFORE THE CAP IS CONSIDERED. Closing a
  // finding the owner has already answered costs them nothing — there is no
  // message, no interruption, no budget to spend — so gating it on the question
  // allowance would be gating the wrong thing. Folded into the ask loop it was
  // exactly that: with five questions outstanding the pass returned early and
  // every settled finding sat open in the admin until somebody replied to
  // something unrelated.
  //
  // A memory only matches when the CONDITION is the one the owner looked at
  // (`lib/control/fingerprint.js`), so "he is a team driver" settles the shared
  // truck it was about and nothing else.
  const unanswered = [];
  for (const finding of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await applyMemory(finding, deps)) skipped.remembered += 1;
    else unanswered.push(finding);
  }

  // THE STANDING CAP, and it is not the same as the per-pass cap. The per-pass
  // cap limits ONE pass; this sweep runs every fifteen minutes, so without this
  // the first day after a deploy would deliver hundreds of questions into a
  // group that has answered none of them. While the owner is already carrying
  // `max_questions_per_pass` unanswered questions, the pass asks nothing — the
  // queue drains at the speed somebody actually answers it.
  if (outstanding >= settings.maxQuestionsPerPass) {
    return {
      asked: 0, considered: candidates.length, skipped,
      reason: 'waiting_for_answers', outstanding,
    };
  }

  for (const finding of unanswered) {
    if (asked + outstanding >= settings.maxQuestionsPerPass) break;

    const action = deps.actionForCheck(finding.checkKey);
    const mode = modeOf(checkSettings.get?.(finding.checkKey));
    const heldDecision = holds.get?.(
      `${finding.checkKey}|${finding.subjectType}|${finding.subjectId}`
    ) || null;
    if (!isAskableFinding(finding, {
      mode, hasAction: Boolean(action), held: Boolean(heldDecision),
    })) {
      skipped.notAskable += 1;
      continue;
    }

    const wording = questionFor(finding, { heldDecision });
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
        // WHY IT IS BEING ASKED rather than done. Without this the journal
        // shows a suggestion beside a hold about the same subject and nothing
        // says they are the same event.
        ...(heldDecision ? { afterHold: heldDecision.verdict } : {}),
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
  SCAN_LIMIT, questionKeyFor, askRoundFor, isAskableFinding, applyMemory,
  runAskPass, defaultDeps,
};
