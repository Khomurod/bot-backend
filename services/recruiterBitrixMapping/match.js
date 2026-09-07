/**
 * Which Bitrix user is which recruiter — the PURE decision.
 *
 * WHY THIS IS CAREFUL. A wrong mapping is worse than no mapping. With no
 * mapping a lead is texted from the shared number, which is merely
 * impersonal; with a WRONG mapping it is texted from a colleague's number,
 * and their reply thread goes to the wrong person. So this module applies a
 * match only when it is both STRONG and UNAMBIGUOUS, and reports everything
 * else for a human to decide instead of guessing.
 *
 * Strength tiers:
 *   phone      — the recruiter's number appears on exactly one Bitrix profile.
 *                Strongest: it is the same number that will send the SMS.
 *   name       — full name matches exactly one profile, in either word order
 *                ("Alex Smith" / "Smith Alex").
 *   first_name — only a first name to go on. PROPOSED, never applied: "Alex"
 *                the recruiter and "Alex" in accounting look identical here.
 *
 * Anything matching two or more profiles — or two recruiters landing on one
 * profile — is ambiguous and left alone.
 *
 * No I/O: the caller supplies both lists and performs the writes.
 */

/** Comparable form of a name: no case, no accents, no punctuation. */
function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(value) {
  return normalizeName(value).split(' ').filter(Boolean);
}

/**
 * Full-name keys for a token list, in both word orders — a recruiter row may
 * be "Alex Smith" while Bitrix holds NAME=Alex LAST_NAME=Smith, or the row may
 * have been typed surname-first.
 */
function fullNameKeys(tokens) {
  if (tokens.length < 2) return [];
  const forward = tokens.join(' ');
  const reversed = [...tokens].reverse().join(' ');
  return forward === reversed ? [forward] : [forward, reversed];
}

/**
 * Last 10 digits, the form two phone strings can be compared in regardless of
 * +1, spaces or parentheses. Shorter values (extensions like "104") are NOT
 * comparable and return '' so they never match.
 */
function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/** Index user ids by every key they can be found under. */
function indexUsers(users) {
  const byPhone = new Map();
  const byFullName = new Map();
  const byFirstName = new Map();

  const push = (map, key, user) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(user);
    else map.set(key, [user]);
  };

  for (const user of users) {
    for (const phone of user.phones || []) push(byPhone, phoneKey(phone), user);

    const tokens = nameTokens([user.firstName, user.lastName].filter(Boolean).join(' '));
    for (const key of fullNameKeys(tokens)) push(byFullName, key, user);
    if (tokens.length) push(byFirstName, tokens[0], user);
  }

  return { byPhone, byFullName, byFirstName };
}

/** The single user a recruiter resolves to, plus how — or why not. */
function resolveCandidate(recruiter, index) {
  const phone = phoneKey(recruiter.phoneNumber);
  const byPhone = phone ? index.byPhone.get(phone) || [] : [];
  if (byPhone.length === 1) return { user: byPhone[0], via: 'phone' };
  if (byPhone.length > 1) return { ambiguous: byPhone, via: 'phone' };

  const tokens = nameTokens(recruiter.name);
  for (const key of fullNameKeys(tokens)) {
    const hits = index.byFullName.get(key) || [];
    if (hits.length === 1) return { user: hits[0], via: 'name' };
    if (hits.length > 1) return { ambiguous: hits, via: 'name' };
  }

  if (tokens.length) {
    const hits = index.byFirstName.get(tokens[0]) || [];
    if (hits.length === 1) return { user: hits[0], via: 'first_name' };
    if (hits.length > 1) return { ambiguous: hits, via: 'first_name' };
  }

  return {};
}

const describeUser = (user) => ({
  bitrixUserId: user.id,
  bitrixUserName: user.fullName,
  bitrixUserActive: user.active !== false,
});

const describeRecruiter = (recruiter) => ({
  recruiterId: recruiter.id,
  recruiterName: recruiter.name,
  recruiterActive: recruiter.active !== false,
});

/**
 * Decide the mapping for every recruiter.
 *
 * Returns:
 *   apply         — strong, unambiguous, safe to write
 *   propose       — first-name-only guesses, for a human to confirm
 *   alreadyMapped — untouched; `mismatch` is set when a strong signal
 *                   disagrees with the stored id (reported, never rewritten)
 *   ambiguous     — matched more than one Bitrix profile
 *   conflicts     — two recruiters landed on the same profile, or the profile
 *                   already belongs to another recruiter
 *   unmatched     — nothing to go on
 */
function matchRecruitersToBitrixUsers({ recruiters = [], users = [] } = {}) {
  const index = indexUsers(users);
  const takenBy = new Map();
  for (const recruiter of recruiters) {
    if (recruiter.bitrixUserId != null) takenBy.set(Number(recruiter.bitrixUserId), recruiter);
  }

  const apply = [];
  const propose = [];
  const alreadyMapped = [];
  const ambiguous = [];
  const conflicts = [];
  const unmatched = [];

  for (const recruiter of recruiters) {
    const found = resolveCandidate(recruiter, index);

    if (recruiter.bitrixUserId != null) {
      const stored = Number(recruiter.bitrixUserId);
      const strong = found.user && found.via !== 'first_name' ? found.user : null;
      alreadyMapped.push({
        ...describeRecruiter(recruiter),
        bitrixUserId: stored,
        bitrixUserName: users.find((u) => u.id === stored)?.fullName || null,
        mismatch: strong && strong.id !== stored
          ? { via: found.via, ...describeUser(strong) }
          : null,
      });
      continue;
    }

    if (found.ambiguous) {
      ambiguous.push({
        ...describeRecruiter(recruiter),
        via: found.via,
        candidates: found.ambiguous.map(describeUser),
      });
      continue;
    }

    if (!found.user) {
      unmatched.push(describeRecruiter(recruiter));
      continue;
    }

    const owner = takenBy.get(found.user.id);
    if (owner) {
      conflicts.push({
        ...describeRecruiter(recruiter),
        ...describeUser(found.user),
        via: found.via,
        reason: `Bitrix user already mapped to ${owner.name}`,
      });
      continue;
    }

    const entry = { ...describeRecruiter(recruiter), ...describeUser(found.user), via: found.via };
    if (found.via === 'first_name') propose.push(entry);
    else apply.push(entry);
  }

  // Two recruiters resolving to one profile: neither is safe to write.
  const counts = new Map();
  for (const entry of apply) counts.set(entry.bitrixUserId, (counts.get(entry.bitrixUserId) || 0) + 1);
  const contested = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id));
  if (contested.size) {
    for (const entry of apply.filter((e) => contested.has(e.bitrixUserId))) {
      conflicts.push({ ...entry, reason: 'Two recruiters match this same Bitrix user' });
    }
  }

  return {
    apply: apply.filter((e) => !contested.has(e.bitrixUserId)),
    propose,
    alreadyMapped,
    ambiguous,
    conflicts,
    unmatched,
  };
}

module.exports = {
  normalizeName,
  nameTokens,
  fullNameKeys,
  phoneKey,
  matchRecruitersToBitrixUsers,
};
