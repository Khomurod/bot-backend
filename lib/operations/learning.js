'use strict';

/**
 * Noticing that Wenze keeps being corrected the same way.
 *
 * Pure. Reverted corrections and refused drafts in, suggestions out. No
 * database, no model, no writes.
 *
 * THE SIGNAL IS A HUMAN UNDOING SOMETHING, which is the only kind of feedback
 * this application actually collects. Nobody fills in a form saying "that was
 * wrong"; they revert the correction, or they answer the candidate themselves.
 * `operational_corrections.reverted_at` and
 * `recruiting_ai_conversations.last_refusal_reason` are therefore the whole
 * input, and both are already written for other reasons.
 *
 * ONE REVERT IS NOT A LESSON. It is a person disagreeing about one row, and
 * they are usually right about that row and nothing more. A rule is proposed
 * only when the SAME `action_key` has been reverted `minCount` times inside a
 * window — the third time is when "this check is wrong" becomes more likely
 * than "these three rows were unusual".
 *
 * AND A SUGGESTION IS ONLY EVER A SUGGESTION. Nothing here changes a setting,
 * disables a check, or edits a rule; it produces a sentence for a person to
 * agree with. The owner's line is that important business rules must not change
 * permanently without an administrator's confirmation, and the cheapest way to
 * keep that true is for the module that spots the pattern to have no way to act
 * on it. It returns data.
 */

const DEFAULTS = {
  /** How far back a pattern counts. Longer and it is archaeology. */
  windowDays: 14,
  /** Reverts of the same action before it is worth saying anything. */
  minCount: 3,
  /** Refusals of the same kind on recruiting drafts before the same applies. */
  minRefusals: 3,
  /** Never propose more than this in one pass — a list nobody reads is no list. */
  maxSuggestions: 5,
};

function toTime(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

function withinWindow(at, nowMs, windowDays) {
  const t = toTime(at);
  return t !== null && t >= nowMs - windowDays * 86400000;
}

/**
 * Corrections a person undid, grouped by what Wenze was doing.
 *
 * `reason` carries the humans' own revert reasons verbatim rather than a
 * paraphrase: three reverts that all say "wrong truck" are a different
 * suggestion from three that say nothing, and the sentence a person wrote when
 * they were annoyed is the most useful thing in the row.
 */
function groupReverts(corrections, { nowMs, windowDays, minCount }) {
  const byAction = new Map();
  for (const c of corrections || []) {
    if (!c?.revertedAt || !withinWindow(c.revertedAt, nowMs, windowDays)) continue;
    const key = String(c.actionKey || 'unknown');
    if (!byAction.has(key)) byAction.set(key, []);
    byAction.get(key).push(c);
  }

  const groups = [];
  for (const [actionKey, rows] of byAction) {
    if (rows.length < minCount) continue;
    groups.push({
      actionKey,
      count: rows.length,
      checkKeys: [...new Set(rows.map((r) => r.checkKey).filter(Boolean))],
      reasons: [...new Set(rows.map((r) => String(r.revertReason || '').trim()).filter(Boolean))],
      revertedBy: [...new Set(rows.map((r) => r.revertedBy).filter(Boolean))],
      subjects: rows.slice(0, 5).map((r) => `${r.subjectType}:${r.subjectId}`),
      firstAt: rows.map((r) => r.revertedAt).sort()[0],
      lastAt: rows.map((r) => r.revertedAt).sort().slice(-1)[0],
    });
  }
  return groups.sort((a, b) => b.count - a.count);
}

/**
 * Drafts the recruiting guard refused, grouped by why.
 *
 * A rising count of `unapproved_figure` means something quite specific and
 * quite fixable: **candidates keep asking about something nobody has taught
 * Wenze.** That is not a defect in the guard, it is a gap in the knowledge
 * base, and it is the one suggestion here that a person can act on in a minute.
 */
function groupRefusals(conversations, { nowMs, windowDays, minRefusals }) {
  const byReason = new Map();
  for (const c of conversations || []) {
    if (!c?.lastRefusalReason || !(c.refusals > 0)) continue;
    if (!withinWindow(c.updatedAt, nowMs, windowDays)) continue;
    // "unapproved_figure — used 92, which no approved statement contains"
    const kind = String(c.lastRefusalReason).split('—')[0].trim() || 'unknown';
    if (!byReason.has(kind)) byReason.set(kind, []);
    byReason.get(kind).push(c);
  }

  const groups = [];
  for (const [kind, rows] of byReason) {
    const total = rows.reduce((n, r) => n + Number(r.refusals || 0), 0);
    if (total < minRefusals) continue;
    groups.push({
      kind,
      count: total,
      conversations: rows.length,
      examples: [...new Set(rows.map((r) => r.lastRefusalReason))].slice(0, 3),
    });
  }
  return groups.sort((a, b) => b.count - a.count);
}

/** What to say about a repeatedly reverted action. Plain, and never a command. */
function describeRevertGroup(group) {
  const what = group.actionKey.replace(/[._]/g, ' ');
  const because = group.reasons.length
    ? ` The reasons given were: ${group.reasons.slice(0, 3).join('; ')}.`
    : ' No reason was recorded on any of them.';
  return {
    kind: 'reverted_correction',
    subjectId: group.actionKey,
    title: `"${what}" has been undone ${group.count} times`,
    lines: [
      `${group.count} corrections of this kind were reverted by a person in the last two weeks.`,
      group.checkKeys.length ? `From check${group.checkKeys.length > 1 ? 's' : ''}: ${group.checkKeys.join(', ')}.` : null,
    ].filter(Boolean),
    // The suggestion is deliberately the conservative one. "Turn this check's
    // automatic correction off and let it propose instead" costs nothing if it
    // is wrong and stops a wrong repair if it is right; "change the rule" is
    // the expensive guess and is not this module's to make.
    suggestion: `Consider switching automatic correction OFF for this check and letting it `
      + `propose instead, until the cases it gets wrong are understood.${because}`,
    evidence: {
      actionKey: group.actionKey,
      count: group.count,
      checkKeys: group.checkKeys,
      reasons: group.reasons.slice(0, 5),
      subjects: group.subjects,
      window: { from: group.firstAt, to: group.lastAt },
    },
  };
}

/** What to say about repeated refusals of Wenze's own recruiting drafts. */
function describeRefusalGroup(group) {
  const isFigure = group.kind === 'unapproved_figure';
  return {
    kind: 'recruiting_refusal',
    subjectId: group.kind,
    title: `Wenze's answer to candidates was refused ${group.count} times (${group.kind.replace(/_/g, ' ')})`,
    lines: [
      `Across ${group.conversations} conversation${group.conversations === 1 ? '' : 's'} in the last two weeks.`,
      ...group.examples.map((e) => `Example: ${e}`),
    ],
    suggestion: isFigure
      ? 'Candidates are asking about something nobody has taught Wenze. Adding the fact '
        + 'under Teach Wenze would let it answer instead of deferring.'
      : 'Worth reading the examples — either the drafts are genuinely unsafe, in which '
        + 'case the guard is doing its job, or an approved boundary needs rewording.',
    evidence: { kind: group.kind, count: group.count, conversations: group.conversations },
  };
}

/**
 * Everything worth proposing this pass.
 *
 * @param {{corrections?: Array, conversations?: Array}} sources
 * @param {{now?: string}} [options]
 * @returns {Array} suggestions, most-evidenced first, capped
 */
function findLessons(sources = {}, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const nowMs = toTime(options.now) ?? Date.now();

  const suggestions = [
    ...groupReverts(sources.corrections, { nowMs, ...opts }).map(describeRevertGroup),
    ...groupRefusals(sources.conversations, { nowMs, ...opts }).map(describeRefusalGroup),
  ];

  return suggestions.slice(0, opts.maxSuggestions);
}

module.exports = {
  DEFAULTS,
  groupReverts,
  groupRefusals,
  describeRevertGroup,
  describeRefusalGroup,
  findLessons,
};
