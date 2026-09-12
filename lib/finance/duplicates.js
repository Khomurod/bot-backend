/**
 * Was this money code already issued? — pure, no I/O.
 *
 * TWO KINDS OF DUPLICATE, AND THEY ARE NOT THE SAME CLAIM.
 *
 *   same_code — the identical code, already seen. This is a fact, not a
 *   judgement: a code is the thing that gets spent, so the same one posted
 *   twice is either a re-post of the same issue or a genuine double-issue, and
 *   either way a person should see it.
 *
 *   same_amount_recipient_window — the same amount, to the same person, inside
 *   a window. This is a SUSPICION. Two $500 advances to one driver in a day is
 *   sometimes exactly right, so it is flagged and never acted on.
 *
 * The distinction is kept in the stored `duplicate_reason` rather than
 * collapsed into a boolean, because the finance report has to be able to say
 * "one code posted twice" without implying "paid twice".
 *
 * NOTHING HERE BLOCKS ANYTHING. Wenze does not issue money codes and cannot
 * recall one; it reads a chat. The only output is a pointer to the earlier row.
 */

const REASON = Object.freeze({
  SAME_CODE: 'same_code',
  SAME_AMOUNT_RECIPIENT_WINDOW: 'same_amount_recipient_window',
});

const DEFAULT_WINDOW_HOURS = 72;

function normalisePerson(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toTime(value) {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * @param candidate  { codeNormalized, amount, issuedToNormalized, issuedAt }
 * @param earlier    the same shape, plus `id`, for rows already stored
 * @param options    { windowHours }
 * @returns `null` when this looks new, else `{ duplicateOfId, reason, detail }`
 *
 * The earlier rows are passed in rather than queried, so the decision is
 * testable without a database and cannot accidentally widen its own search.
 */
function decideDuplicate(candidate, earlier = [], options = {}) {
  if (!candidate) return null;
  const rows = Array.isArray(earlier) ? earlier : [];
  const windowHours = Number(options.windowHours) > 0
    ? Number(options.windowHours)
    : DEFAULT_WINDOW_HOURS;

  // A code is the strongest evidence there is, so it is checked first and
  // without a time window: the same code a month apart is still the same code.
  const code = String(candidate.codeNormalized || '').trim();
  if (code) {
    const match = rows.find((r) => String(r.codeNormalized || '').trim() === code);
    if (match) {
      return {
        duplicateOfId: match.id ?? null,
        reason: REASON.SAME_CODE,
        detail: 'this exact code was already recorded',
      };
    }
  }

  // The weaker signal needs all three of amount, recipient and a readable time.
  // Missing any one of them makes the claim unsupportable, so it is not made.
  const amount = Number(candidate.amount);
  const person = normalisePerson(candidate.issuedToNormalized || candidate.issuedTo);
  const at = toTime(candidate.issuedAt);
  if (!Number.isFinite(amount) || amount <= 0 || !person || at === null) return null;

  const windowMs = windowHours * 60 * 60 * 1000;
  const match = rows.find((r) => {
    const rAt = toTime(r.issuedAt);
    if (rAt === null) return false;
    if (Math.abs(at - rAt) > windowMs) return false;
    if (Number(r.amount) !== amount) return false;
    return normalisePerson(r.issuedToNormalized || r.issuedTo) === person;
  });

  if (!match) return null;
  return {
    duplicateOfId: match.id ?? null,
    reason: REASON.SAME_AMOUNT_RECIPIENT_WINDOW,
    detail: `same amount to the same person within ${windowHours}h`,
  };
}

module.exports = { REASON, DEFAULT_WINDOW_HOURS, decideDuplicate, normalisePerson };
