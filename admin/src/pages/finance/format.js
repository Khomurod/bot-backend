/**
 * Shared formatting for the Finance page. PURE.
 *
 * `money` and the status vocabularies live here rather than in each tab,
 * because three tables showing the same status word differently is how a
 * screen stops being trustworthy about money.
 */

export function money(amount, currency = "USD") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  return `${currency === "USD" ? "$" : `${currency} `}${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

export function when(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/**
 * What the parser made of a message, in words.
 *
 * "Unclear" and "Could not read" are separate because they are separate
 * answers: the first means the parser found more than one candidate and
 * refused to pick, the second that it found none. They are the two piles the
 * provisional parser is tightened from, and folding them together would lose
 * the distinction that makes that possible.
 */
export const PARSE_STATUS = {
  parsed: "Read",
  ambiguous: "Unclear — more than one candidate",
  unparsed: "Could not read a code",
  not_moneycode: "Not about money",
};

/**
 * A document's fate. `failed` and `needs_review` are deliberately far apart:
 * one is worth retrying and the other needs a person.
 */
export const DOCUMENT_STATUS = {
  pending: "Waiting to be read",
  processing: "Being read",
  read: "Read",
  needs_review: "Needs a person",
  failed: "Could not be fetched",
  skipped_too_large: "Skipped — too large",
  skipped_unsupported: "Skipped — unsupported type",
};

/** Why a person is being asked to look. */
export const REVIEW_REASON = {
  ai_unavailable: "AI was unavailable",
  low_confidence: "not confident enough",
  missing_fields: "no amount or no date",
  no_text: "nothing readable in it",
  invalid_answer: "the reading came back unusable",
};

/**
 * A repeat, in words that do not claim a payment happened twice. `same_code`
 * is a fact; the other is a suspicion, and the wording says which.
 */
export const DUPLICATE_REASON = {
  same_code: "this code was posted before",
  same_amount_recipient_window: "same amount to the same person recently — often legitimate",
};

export const REPORT_STATUS = {
  sent: "Sent",
  failed: "Could not send — will retry",
  suppressed_backfill: "Not sent — we were not watching that week",
  manual: "Sent by hand",
};
