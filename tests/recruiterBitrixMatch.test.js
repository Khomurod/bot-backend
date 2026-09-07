/**
 * Which Bitrix user is which recruiter — and, more importantly, when the
 * matcher must REFUSE to decide.
 *
 * The asymmetry these tests encode: an unmapped recruiter costs a lead the
 * personal touch (it goes out from the shared number), while a WRONGLY mapped
 * recruiter texts a driver from a colleague's phone and routes the reply to
 * the wrong person. So every ambiguous case below must land in `ambiguous`,
 * `conflicts` or `propose` — never in `apply`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeName,
  fullNameKeys,
  nameTokens,
  phoneKey,
  matchRecruitersToBitrixUsers,
} = require('../services/recruiterBitrixMapping/match');

const user = (id, firstName, lastName, extra = {}) => ({
  id, firstName, lastName,
  fullName: [firstName, lastName].filter(Boolean).join(' '),
  email: '', position: '', phones: [], active: true,
  ...extra,
});

const recruiter = (id, name, phoneNumber, extra = {}) => ({
  id, name, phoneNumber, active: true, bitrixUserId: null, ...extra,
});

// ─── the normalizers ───

test('names compare without case, accents or punctuation', () => {
  assert.equal(normalizeName("José  O'Brien-Smith"), 'jose o brien smith');
  assert.equal(normalizeName('  ALEX   SMITH '), 'alex smith');
  assert.equal(normalizeName(null), '');
});

test('a full name is comparable in either word order', () => {
  assert.deepEqual(fullNameKeys(nameTokens('Alex Smith')), ['alex smith', 'smith alex']);
});

test('a one-word name has no full-name key at all', () => {
  assert.deepEqual(fullNameKeys(nameTokens('Alex')), []);
});

test('phones compare on the last 10 digits, and an extension never compares', () => {
  assert.equal(phoneKey('+1 (555) 000-1111'), '5550001111');
  assert.equal(phoneKey('5550001111'), '5550001111');
  assert.equal(phoneKey('104'), '', 'an extension is not a comparable number');
  assert.equal(phoneKey(''), '');
});

// ─── what gets applied ───

test('the recruiter number found on exactly one Bitrix profile is applied', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Whoever', '+15550001111')],
    users: [user(17, 'Alex', 'Smith', { phones: ['(555) 000-1111'] }), user(18, 'Bo', 'Lee')],
  });
  assert.deepEqual(plan.apply.map((e) => [e.recruiterId, e.bitrixUserId, e.via]), [[1, 17, 'phone']]);
  assert.equal(plan.ambiguous.length, 0);
});

test('a full name matches in either stored word order', () => {
  const users = [user(17, 'Alex', 'Smith')];
  const forward = matchRecruitersToBitrixUsers({ recruiters: [recruiter(1, 'Alex Smith', '+15559999999')], users });
  const reversed = matchRecruitersToBitrixUsers({ recruiters: [recruiter(1, 'Smith Alex', '+15559999999')], users });
  assert.deepEqual(forward.apply.map((e) => e.bitrixUserId), [17]);
  assert.deepEqual(reversed.apply.map((e) => e.bitrixUserId), [17]);
  assert.equal(reversed.apply[0].via, 'name');
});

test('the phone wins over a name that points elsewhere', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex Smith', '+15550001111')],
    users: [user(17, 'Alex', 'Smith'), user(18, 'Someone', 'Else', { phones: ['+15550001111'] })],
  });
  assert.deepEqual(plan.apply.map((e) => [e.bitrixUserId, e.via]), [[18, 'phone']]);
});

// ─── what must NOT be applied ───

test('one number on two Bitrix profiles is ambiguous, not a guess', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex Smith', '+15550001111')],
    users: [
      user(17, 'Alex', 'Smith', { phones: ['+15550001111'] }),
      user(18, 'Shared', 'Desk', { phones: ['+15550001111'] }),
    ],
  });
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.ambiguous[0].via, 'phone');
  assert.deepEqual(plan.ambiguous[0].candidates.map((c) => c.bitrixUserId), [17, 18]);
});

test('two Bitrix profiles with the same name are ambiguous', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex Smith', '+15559999999')],
    users: [user(17, 'Alex', 'Smith'), user(18, 'Alex', 'Smith')],
  });
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.ambiguous.length, 1);
});

test('a first name alone is PROPOSED, never applied', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex', '+15559999999')],
    users: [user(17, 'Alex', 'Smith')],
  });
  assert.equal(plan.apply.length, 0, 'one name is not enough to write');
  assert.deepEqual(plan.propose.map((e) => [e.bitrixUserId, e.via]), [[17, 'first_name']]);
});

test('one profile listing the same number twice is one candidate, not an ambiguity', () => {
  // A Bitrix profile commonly repeats the number across PERSONAL_MOBILE and
  // WORK_PHONE. Counting it twice would refuse the strongest match there is.
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex Smith', '+15550001111')],
    users: [user(17, 'Alex', 'Smith', { phones: ['+15550001111', '(555) 000-1111', '555-000-1111'] })],
  });
  assert.deepEqual(plan.apply.map((e) => [e.bitrixUserId, e.via]), [[17, 'phone']]);
  assert.equal(plan.ambiguous.length, 0);
});

test('two first-name PROPOSALS for one Bitrix user are a conflict, not two tickboxes', () => {
  // Confirming both would have let the unique index pick a winner by write
  // order — an arbitrary mapping presented as a choice.
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex', '+15559990000'), recruiter(2, 'Alex', '+15559991111')],
    users: [user(17, 'Alex', 'Smith')],
  });
  assert.equal(plan.propose.length, 0, 'neither may be offered');
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.conflicts.length, 2);
  assert.match(plan.conflicts[0].reason, /same Bitrix user/i);
});

test('a strong match beats a first-name claim on the same user, and keeps applying', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [
      recruiter(1, 'Alex Smith', '+15550001111'),  // phone → 17
      recruiter(2, 'Alex', '+15559991111'),        // first name → 17
    ],
    users: [user(17, 'Alex', 'Smith', { phones: ['+15550001111'] })],
  });
  assert.deepEqual(plan.apply.map((e) => [e.recruiterId, e.via]), [[1, 'phone']]);
  assert.equal(plan.propose.length, 0, 'the weak claim is withdrawn, not left confirmable');
  assert.deepEqual(plan.conflicts.map((e) => e.recruiterId), [2]);
  assert.match(plan.conflicts[0].reason, /matched more strongly by Alex Smith/i);
});

test('two recruiters landing on one Bitrix user disqualifies both', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex Smith', '+15550001111'), recruiter(2, 'Smith Alex', '+15552223333')],
    users: [user(17, 'Alex', 'Smith')],
  });
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.conflicts.length, 2);
  assert.match(plan.conflicts[0].reason, /same Bitrix user/i);
});

test('a Bitrix user already mapped to someone else is a conflict, not a move', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [
      recruiter(1, 'Alex Smith', '+15550001111', { bitrixUserId: 17 }),
      recruiter(2, 'Alex Smith', '+15552223333'),
    ],
    users: [user(17, 'Alex', 'Smith')],
  });
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].recruiterId, 2);
  assert.match(plan.conflicts[0].reason, /already mapped to Alex Smith/i);
});

// ─── an existing mapping is the operator's, not ours ───

test('a stored mapping is reported and never rewritten', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex Smith', '+15550001111', { bitrixUserId: 17 })],
    users: [user(17, 'Alex', 'Smith', { phones: ['+15550001111'] })],
  });
  assert.equal(plan.apply.length, 0);
  assert.deepEqual(plan.alreadyMapped.map((e) => [e.recruiterId, e.bitrixUserId]), [[1, 17]]);
  assert.equal(plan.alreadyMapped[0].mismatch, null);
});

test('a stored mapping that disagrees with the phone is flagged, not corrected', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex Smith', '+15550001111', { bitrixUserId: 99 })],
    users: [user(17, 'Alex', 'Smith', { phones: ['+15550001111'] })],
  });
  assert.equal(plan.apply.length, 0, 'the operator decides, not the matcher');
  assert.equal(plan.alreadyMapped[0].mismatch.bitrixUserId, 17);
  assert.equal(plan.alreadyMapped[0].mismatch.via, 'phone');
});

test('a weak first-name hit never counts as a mismatch against a stored id', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex', '+15559999999', { bitrixUserId: 99 })],
    users: [user(17, 'Alex', 'Smith')],
  });
  assert.equal(plan.alreadyMapped[0].mismatch, null);
});

// ─── nothing to go on, and the flags carried through ───

test('a recruiter with no Bitrix counterpart is reported as unmatched', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Nobody Here', '+15558887777')],
    users: [user(17, 'Alex', 'Smith')],
  });
  assert.deepEqual(plan.unmatched.map((e) => e.recruiterId), [1]);
});

test('an empty portal matches nobody and throws nothing', () => {
  const plan = matchRecruitersToBitrixUsers({ recruiters: [recruiter(1, 'Alex Smith', '+15550001111')], users: [] });
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.unmatched.length, 1);
});

test('no arguments at all is an empty plan, not a crash', () => {
  const plan = matchRecruitersToBitrixUsers();
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.unmatched, []);
});

test('a deactivated Bitrix user still matches, but is flagged as inactive', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex Smith', '+15550001111')],
    users: [user(17, 'Alex', 'Smith', { phones: ['+15550001111'], active: false })],
  });
  assert.equal(plan.apply[0].bitrixUserActive, false);
});

test('an inactive recruiter is mapped too — identity outlives activation', () => {
  const plan = matchRecruitersToBitrixUsers({
    recruiters: [recruiter(1, 'Alex Smith', '+15550001111', { active: false })],
    users: [user(17, 'Alex', 'Smith', { phones: ['+15550001111'] })],
  });
  assert.equal(plan.apply.length, 1);
  assert.equal(plan.apply[0].recruiterActive, false);
});
