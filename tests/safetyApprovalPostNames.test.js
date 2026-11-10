'use strict';

/**
 * Who a recruiter's post is about — lib/safetyApprovals/postDetails.js, and
 * what services/safetyApprovals/reviewer.js does with it under a hashtag.
 *
 * Pinned (November 2026): a card with ONE driver and lines ABOUT the driver
 * ("Matthew's referral", "All Consents are signed", "Referral: …") is one
 * driver, decided by the hashtag with no model and no question. Until then a
 * possessive line read as a second driver, the card looked like a team, and
 * every `#Approved` under it was asked about. Real teams are still asked when
 * the hashtag names nobody, and a post that SAYS it is a team is never decided
 * as one driver even when only one name could be read.
 *
 * The names here are invented; the card SHAPES are the recruiting group's own.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { readPostNames, namesInPost } = require('../lib/safetyApprovals/postDetails');
const fx = require('./helpers/safetyApprovalFixture');

const {
  state, processReview, SAFETY, RECRUITER, AGO, msg, photo, model, deps, review, reset,
} = fx;

const say = (messageId, text, fields = {}) => msg({
  messageId, fromUserId: SAFETY, fromName: 'Aubrey Davis', text, sentAt: AGO(300), ...fields,
});
const noDownload = { download: async () => { throw new Error('nothing may be downloaded'); } };
const captionOf = (call) => call.media?.[0]?.caption ?? call.extra?.caption ?? call.text;

const REFERRAL_CARD = 'Company Driver - 99 CPM\n\nKWAME ASANTE\n(555) 201-3344\n9+ yrs of exp\n\nMatthew\'s referral';

test('a one-driver card with a referral line is ONE driver', () => {
  assert.deepEqual(readPostNames(REFERRAL_CARD), { names: ['Kwame Asante'], doubtful: 0, team: false });
  assert.deepEqual(namesInPost('Company Driver\n\nMUGISHA  JEAN PAUL CLAUDE\n9+ yrs of exp\n(555) 201-3344\n\n'
    + 'All Consents are signed\nDaniel’s referral'), ['Mugisha Jean Paul Claude']);
  assert.deepEqual(namesInPost('COMPANY DRIVER - 99 CPM\n\nHABIMANA ERIC\n9+ yrs of exp\n@someone99\n\nMatthew\'s referral'),
    ['Habimana Eric']);
});

test('lines ABOUT the driver — referral, recruiter, status, job, experience — never become a driver', () => {
  const about = [
    "Ann's referral", 'Referral: Ann Lee', 'Referred by Ann Lee', 'Ann Lee referral', 'Ref - Ann Lee',
    'Recruiter: Ann Lee', 'Recruiter - Ann Lee', 'Recruited by Ann Lee', 'Status: Awaiting signature',
    'Awaiting signature', 'Consent signed', 'Position: Company driver', 'Job: Dedicated', 'Experience - Over Two',
    'Endorsements: Hazmat Tanker', 'For Polvon’s truck', 'Pending MRO Review', 'Son of Ruslan Abdul',
    'Assalomu alekum,', 'Brother of Ann Lee',
  ];
  for (const line of about) {
    assert.deepEqual(readPostNames(`${line}\nJOHN OKAFOR\n(555) 201-3344`).names, ['John Okafor'], line);
  }
});

test('names are still read in every way recruiters write them', () => {
  assert.deepEqual(namesInPost('Ibeagwa, MarkAnthony O.'), ['Ibeagwa Markanthony O.']);
  assert.deepEqual(namesInPost('SHARP JAMES EDWARD, III'), ['Sharp James Edward Iii']);
  assert.deepEqual(namesInPost('Hills Emanuel . JR'), ['Hills Emanuel Jr']);
  assert.deepEqual(namesInPost('Maria de la Cruz'), ['Maria De La Cruz']);
  assert.deepEqual(namesInPost('Driver: john okafor'), ['John Okafor'], 'a name label waives the capitals');
  assert.deepEqual(namesInPost('Full name - JOHN OKAFOR'), ['John Okafor']);
});

test('what is not certain is said so: small letters are doubtful, a team post is marked', () => {
  assert.deepEqual(readPostNames('john okafor\nMIKE JONES\n(555) 201-3344'), { names: ['Mike Jones'], doubtful: 1, team: false });
  assert.deepEqual(readPostNames('Team Driver For UNIT 310 AKMAL RUSTAMOV\n\nSardor Karimov\n555-201-3344'),
    { names: ['Sardor Karimov'], doubtful: 0, team: true });
  for (const text of ['Company team drivers 95 CPM', 'TEAM - 85 CPM', 'Darnell Brooks (main)', 'Co-driver: Calvin Brooks',
    'Company Driver - Team', 'Driver 2: Calvin Brooks']) {
    assert.equal(readPostNames(text).team, true, text);
  }
  for (const text of ['Good morning team,', 'Hello team', 'Team, Jordan is arriving Monday', REFERRAL_CARD]) {
    assert.equal(readPostNames(text).team, false, text);
  }
});

const referralPost = () => [
  msg({ messageId: 10, fromUserId: RECRUITER, fromName: 'Kim R', mediaGroupId: 'p1', photos: photo('cdl-front'), text: REFERRAL_CARD }),
  msg({ messageId: 11, fromUserId: RECRUITER, fromName: 'Kim R', mediaGroupId: 'p1', photos: photo('cdl-back') }),
];

test('#Approved under a referral card: posted for the ONE driver, no model, no question', async () => {
  reset([...referralPost(), say(21, '#Approved', { replyToMessageId: 10 })]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: 10 }), d), 'published');
  assert.equal(d.telegram.calls.length, 1, 'one post, no "Which driver is this about?"');
  assert.match(captionOf(d.telegram.calls[0]), /KWAME ASANTE[\s\S]*✅ <b>APPROVED<\/b> by Aubrey Davis/);
  assert.doesNotMatch(captionOf(d.telegram.calls[0]), /— <b>/, 'not labelled as one of a team');
  assert.equal(state.finished.at(-1).outcome.mode, 'hashtag');
  assert.equal(state.announcements.length, 1, 'one driver announced');
});

test('#NotApproved under a referral card: the one driver, the reason kept', async () => {
  reset([...referralPost(), say(21, '#NotApproved 3 accidents', { replyToMessageId: 11 })]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: 11 }), d), 'published');
  assert.match(captionOf(d.telegram.calls[0]), /❌ <b>NOT APPROVED<\/b> by Aubrey Davis\n📝 Reason: 3 accidents/);
});

test('a post that SAYS team with one readable name: the model reads the names, and an unnamed hashtag is asked', async () => {
  reset([
    msg({ messageId: 30, fromUserId: RECRUITER, photos: photo('cdl'),
      text: 'Team Driver For UNIT 310 AKMAL RUSTAMOV\n\nSardor Karimov\n555-201-3344' }),
    say(40, '#Approved', { replyToMessageId: 30 }),
  ]);
  const d = deps({ readReply: model({
    candidates: [{ name: 'Akmal Rustamov', cdl_photo: null }, { name: 'Sardor Karimov', cdl_photo: null }],
    decisions: [],
  }) });
  assert.equal(await processReview(review({ safetyKey: 'message:40', postMessageId: 30 }), d), 'unclear');
  assert.match(d.telegram.calls[0].text, /more than one driver/);
  assert.equal(state.announcements.length, 0);
});

test('a team post whose model reading finds only one driver still never gives that one the decision unnamed', async () => {
  reset([
    msg({ messageId: 30, fromUserId: RECRUITER, photos: photo('cdl'),
      text: 'Team Driver For UNIT 310 AKMAL RUSTAMOV\n\nSardor Karimov\n555-201-3344' }),
    say(40, '#Approved', { replyToMessageId: 30 }),
  ]);
  const d = deps({ readReply: model({ candidates: [{ name: 'Sardor Karimov', cdl_photo: null }], decisions: [] }) });
  assert.equal(await processReview(review({ safetyKey: 'message:40', postMessageId: 30 }), d), 'unclear');
  assert.equal(state.announcements.length, 0);

  state.rows = [...state.rows.slice(0, 1), say(40, '#Approved Sardor', { replyToMessageId: 30 })];
  const named = deps({ readReply: model({ candidates: [{ name: 'Sardor Karimov', cdl_photo: null }], decisions: [] }) });
  assert.equal(await processReview(review({ id: 2, safetyKey: 'message:40', postMessageId: 30 }), named), 'published');
  assert.match(captionOf(named.telegram.calls[0]), /✅ <b>APPROVED<\/b>/);
});

test('a second name in small letters: the model is asked for the names instead of trusting one', async () => {
  reset([
    msg({ messageId: 30, fromUserId: RECRUITER, photos: photo('cdl'), text: 'MIKE JONES\njohn okafor\n(555) 201-3344' }),
    say(40, '#Approved', { replyToMessageId: 30 }),
  ]);
  let asked = 0;
  const reader = model({ candidates: [{ name: 'Mike Jones', cdl_photo: null }, { name: 'John Okafor', cdl_photo: null }], decisions: [] });
  const d = deps({ readReply: async (args) => { asked += 1; return reader(args); } });
  assert.equal(await processReview(review({ safetyKey: 'message:40', postMessageId: 30 }), d), 'unclear');
  assert.equal(asked, 1);
  assert.match(d.telegram.calls[0].text, /more than one driver/);
});
