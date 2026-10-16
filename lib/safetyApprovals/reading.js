'use strict';

/**
 * What a model said about a Safety reply, reduced to what the messages prove.
 * Pure.
 *
 * The model reads the recruiter's post (text and photos) and Safety's reply,
 * and says who the candidates are and what Safety decided for each. It is
 * there for the LANGUAGE — "we can hire him", "good to go", "cleared",
 * "can't take him, 3 accidents" — and it is good at that. It is not trusted
 * with anything a message can be checked against, and a wrong "APPROVED"
 * posted in the recruiting group is a driver Safety refused being onboarded.
 * So, here, and not in the prompt:
 *
 *   - a NAME must appear in the post, in Safety's words or in the file names
 *     Safety attached ("DARNELL BROOKS PSP.pdf"); a name from nowhere is
 *     dropped, and its decision with it;
 *   - a PHONE must be one the recruiter wrote; otherwise there is no phone;
 *   - an "approved" is refused when Safety's words also carry a refusal
 *     ("can't hire", "not approved", "denied", …) or ask a question — both
 *     mean the reply is not a plain yes;
 *   - in a post with two drivers (a team), a decision counts only for a
 *     driver Safety actually named, or for all of them when Safety says
 *     "both" / "them" / "team". "We can hire Darnell Brooks" says nothing
 *     about Calvin Brooks, whatever a model infers.
 *
 * The third answer is not a synonym for yes or no: anything dropped here is
 * simply not posted, and the review is recorded as `unclear`.
 */

const DECISIONS = Object.freeze(['approved', 'not_approved']);

/** Safety's words carry a refusal, so an "approved" reading is not a plain yes. */
const NEGATIVE = new RegExp([
  "(?:can'?t|cannot|can not|won'?t|unable to|not able to|shouldn'?t|should not)\\s+(?:be\\s+)?"
    + '(?:hire|hired|approve|approved|onboard|take|accept|move forward|proceed|use)',
  'not\\s+(?:approved|eligible|hireable|qualified|cleared|good to go|a fit|hiring)',
  "\\b(?:deny|denied|reject|rejected|decline|declined|disqualif\\w*|do not hire|don'?t hire|no hire|pass on|unqualified|ineligible)\\b",
].join('|'), 'i');

/** "both", "them", "the team": a decision about every candidate in the post. */
const PLURAL = /\b(?:both|them|they|all|team|everyone|each)\b/i;

function tokensOf(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token.length >= 2);
}

function cleanName(name) {
  const tokens = tokensOf(name);
  if (!tokens.length || tokens.length > 4) return null;
  return tokens.map((t) => t[0].toUpperCase() + t.slice(1)).join(' ');
}

/** Stable key for "the same driver", used so a decision is never posted twice. */
function driverKey(name) {
  return tokensOf(name).join(' ');
}

function tokenSet(sources) {
  return new Set(sources.flatMap((source) => tokensOf(source)));
}

const PHONE = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/g;

/** The phone numbers the recruiter wrote, keyed by their last ten digits. */
function phonesIn(text) {
  const found = new Map();
  for (const match of String(text || '').matchAll(PHONE)) {
    const digits = match[0].replace(/\D/g, '').slice(-10);
    if (digits.length === 10 && !found.has(digits)) found.set(digits, match[0].trim());
  }
  return found;
}

/** The model's phone, as the recruiter wrote it — or null if the recruiter did not. */
function verifiedPhone(phone, postText) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return null;
  return phonesIn(postText).get(digits) || null;
}

/**
 * Did Safety name this candidate? By a token no other candidate shares, so
 * "Brooks" does not name both Darnell Brooks and Calvin Brooks.
 */
function namedBy(candidate, others, safetySources) {
  const said = tokenSet(safetySources);
  const theirs = new Set(others.flatMap((other) => tokensOf(other.name)));
  const own = tokensOf(candidate.name).filter((t) => t.length >= 3);
  const distinctive = own.filter((t) => !theirs.has(t));
  const pool = distinctive.length ? distinctive : own;
  return pool.some((t) => said.has(t));
}

/**
 * The part of Safety's reply that is about this candidate. In a team post,
 * "Darnell approved, Calvin not approved" carries a refusal — but not about
 * Darnell, so the refusal and question checks look only at the clauses that
 * name him. When no clause names anybody ("approved both"), it is all of it.
 */
function wordsAbout(candidate, others, safetyText) {
  if (!others.length) return safetyText;
  const clauses = String(safetyText || '').split(/[.;!\n,]+|\bbut\b/i).filter((c) => c.trim());
  const about = clauses.filter((clause) => namedBy(candidate, others, [clause]));
  return about.length ? about.join('. ') : safetyText;
}

function findCandidate(candidates, name) {
  const wanted = tokensOf(name);
  if (!wanted.length) return null;
  const exact = candidates.find((c) => c.key === wanted.join(' '));
  if (exact) return exact;
  const matches = candidates.filter((c) => {
    const have = new Set(tokensOf(c.name));
    return wanted.every((t) => have.has(t)) || tokensOf(c.name).every((t) => wanted.includes(t));
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * @param {object} raw          the model's parsed answer
 * @param {object} ctx
 * @param {string} ctx.postText     the recruiter's words
 * @param {string} ctx.safetyText   Safety's words
 * @param {string[]} ctx.fileNames  names of the files Safety attached
 * @param {number} ctx.photoCount   how many photos the model was shown
 * @returns {{candidates: object[], decisions: object[], dropped: object[]}}
 */
function verifyReading(raw, {
  postText = '', safetyText = '', fileNames = [], photoCount = 0,
} = {}) {
  const dropped = [];
  const candidates = [];
  const everywhere = tokenSet([postText, safetyText, ...fileNames]);

  for (const item of Array.isArray(raw?.candidates) ? raw.candidates : []) {
    const name = cleanName(item?.name);
    if (!name) continue;
    if (!tokensOf(name).every((t) => everywhere.has(t))) {
      dropped.push({ name, why: 'name_not_in_messages' });
      continue;
    }
    const key = driverKey(name);
    if (candidates.some((c) => c.key === key)) continue;
    const index = Number(item?.cdl_photo);
    candidates.push({
      key,
      name,
      phone: verifiedPhone(item?.phone, postText),
      cdlPhoto: Number.isInteger(index) && index >= 0 && index < photoCount ? index : null,
    });
  }

  // Safety's WORDS name a driver; a file name does not. Safety may attach both
  // drivers' reports and still approve only one of them.
  const safetySources = [safetyText];
  const team = candidates.length >= 2;
  const byKey = new Map();
  for (const item of Array.isArray(raw?.decisions) ? raw.decisions : []) {
    const decision = String(item?.decision || '').toLowerCase();
    if (!DECISIONS.includes(decision)) continue;
    const candidate = findCandidate(candidates, item?.name);
    if (!candidate) {
      dropped.push({ name: cleanName(item?.name), why: 'decision_without_candidate' });
      continue;
    }
    const others = candidates.filter((c) => c !== candidate);
    if (team && !namedBy(candidate, others, safetySources) && !PLURAL.test(safetyText)) {
      dropped.push({ name: candidate.name, why: 'not_named_by_safety' });
      continue;
    }
    const about = wordsAbout(candidate, others, safetyText);
    if (decision === 'approved' && NEGATIVE.test(about)) {
      dropped.push({ name: candidate.name, why: 'approval_with_refusal_words' });
      continue;
    }
    if (decision === 'approved' && about.includes('?')) {
      dropped.push({ name: candidate.name, why: 'approval_phrased_as_question' });
      continue;
    }
    const held = byKey.get(candidate.key);
    if (held && held.decision !== decision) {
      // Two answers for one driver: that is not an answer.
      held.conflict = true;
      continue;
    }
    byKey.set(candidate.key, { ...candidate, decision });
  }

  const decisions = [];
  for (const item of byKey.values()) {
    if (item.conflict) dropped.push({ name: item.name, why: 'conflicting_decisions' });
    else decisions.push(item);
  }
  return { candidates, decisions, dropped };
}

/**
 * Which of Safety's files belong with this candidate. In a team, a file whose
 * name names the OTHER driver ("CALVIN BROOKS MVR.pdf") is not posted under
 * this one; a file that names nobody goes with every driver decided.
 */
function documentsFor(candidate, candidates, documents) {
  const others = candidates.filter((c) => c.key !== candidate.key);
  if (!others.length) return documents;
  return documents.filter((doc) => {
    if (!doc.fileName) return true;
    if (namedBy(candidate, others, [doc.fileName])) return true;
    return !others.some((other) => namedBy(other, candidates.filter((c) => c.key !== other.key), [doc.fileName]));
  });
}

module.exports = {
  verifyReading,
  documentsFor,
  driverKey,
  cleanName,
  phonesIn,
  NEGATIVE,
  DECISIONS,
};
