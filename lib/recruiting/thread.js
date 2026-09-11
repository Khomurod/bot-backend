'use strict';

/**
 * One candidate's SMS conversation, as a model should see it.
 *
 * Pure. Mirror rows in, ordered turns out.
 *
 * `facebook_lead_sms_mirrors` is the ledger every SMS already passes through,
 * so the thread is assembled from what the system recorded rather than from a
 * second store that could disagree with it. Four kinds of row reach it:
 *
 *   inbound_rc          the candidate wrote
 *   outbound_auto       the opening template went out
 *   outbound_recruiter  a recruiter typed a reply in Telegram
 *   outbound_ai         Wenze answered after hours, in the recruiter's name
 *
 * The last two are new. `outbound_recruiter` in particular closes a hole that
 * predates this feature: a reply typed in Telegram was SENT and never RECORDED,
 * so the database held the company's opening line and the candidate's answers
 * and nothing in between. Any reading of that thread — a model's or a person's
 * — was reading half a conversation and could not tell.
 *
 * WENZE'S OWN TURNS ARE LABELLED AS WENZE, not merged into the recruiter's.
 * They went out under the recruiter's name and the candidate cannot tell them
 * apart, but the model must: "I already said this" and "a person already said
 * this" carry different weight when deciding whether to answer again, and a
 * human reading the transcript after a complaint needs to know which is which.
 */

const ROLE_BY_SOURCE = new Map([
  ['inbound_rc', 'candidate'],
  ['outbound_auto', 'recruiter'],
  ['outbound_recruiter', 'recruiter'],
  ['outbound_ai', 'wenze'],
]);

const SPEAKER = {
  candidate: 'Candidate',
  recruiter: 'Recruiter',
  wenze: 'You (earlier, after hours)',
};

/** Sources a mirror row may carry. The insert allow-list reads this. */
const MIRROR_SOURCES = [...ROLE_BY_SOURCE.keys()];

function toTime(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * @param {Array} rows  `facebook_lead_sms_mirrors` rows, any order
 * @param {{limit?: number}} [options] how many turns the model sees, newest kept
 * @returns {Array<{role: string, text: string, at: string|null}>} oldest first
 */
function buildThread(rows, { limit = 12 } = {}) {
  const turns = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const role = ROLE_BY_SOURCE.get(String(row?.source_type || ''));
      const text = String(row?.sms_body ?? '').trim();
      if (!role || !text) return null;
      return { role, text, at: row?.created_at ? new Date(row.created_at).toISOString() : null, _t: toTime(row?.created_at), _id: Number(row?.id) || 0 };
    })
    .filter(Boolean)
    // Oldest first. Two rows written in the same second are ordered by id, so a
    // question and its answer never swap places.
    .sort((a, b) => a._t - b._t || a._id - b._id);

  // Keep the NEWEST `limit`, then restore chronological order. Trimming from
  // the old end rather than the new one matters: the last thing the candidate
  // said is the thing being answered.
  const kept = limit > 0 ? turns.slice(-limit) : turns;
  return kept.map(({ role, text, at }) => ({ role, text, at }));
}

/** The turns rendered for a prompt. Plain, no markdown, speakers named. */
function renderThread(turns) {
  return (turns || [])
    .map((turn) => `${SPEAKER[turn.role] || turn.role}: ${turn.text}`)
    .join('\n');
}

/** The candidate's most recent message, which is the one being answered. */
function lastCandidateMessage(turns) {
  for (let i = (turns || []).length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'candidate') return turns[i];
  }
  return null;
}

/**
 * Has a person answered since Wenze last did?
 *
 * When a recruiter has stepped in, the conversation is theirs again and the
 * after-hours reply counter no longer describes it — somebody is awake and
 * handling this. The orchestrator uses it to stand down rather than to reset
 * the count, because resetting would let one conversation loop for ever.
 */
function recruiterSpokeAfterWenze(turns) {
  let sawWenze = false;
  for (const turn of turns || []) {
    if (turn.role === 'wenze') sawWenze = true;
    else if (turn.role === 'recruiter' && sawWenze) return true;
  }
  return false;
}

module.exports = {
  ROLE_BY_SOURCE,
  MIRROR_SOURCES,
  SPEAKER,
  buildThread,
  renderThread,
  lastCandidateMessage,
  recruiterSpokeAfterWenze,
};
