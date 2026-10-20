'use strict';

/**
 * The pure readers behind the #Approved / #NotApproved convention: which
 * Safety messages are decisions at all, what a post says without a model, and
 * who a hashtag decides about. Names and numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { readTrigger, isDecisionMessage, reasonFrom } = require('../lib/safetyApprovals/trigger');
const { namesInPost, personName } = require('../lib/safetyApprovals/postDetails');
const { decideByHashtag } = require('../lib/safetyApprovals/hashtagDecision');

test('every spelling of the two hashtags is read; mixed ones are kept apart', () => {
  for (const [text, hashtag] of [
    ['#Approved', 'approved'], ['#approved', 'approved'], ['# Approved', 'approved'],
    ['#NotApproved', 'not_approved'], ['#Not_Approved', 'not_approved'], ['#not-approved', 'not_approved'],
    ['#notapproved driver at fault', 'not_approved'],
    ['#Approved Darnell #NotApproved Calvin', 'mixed'],
    ['approved', null], ['CLH sent', null],
  ]) {
    assert.equal(readTrigger(text).hashtag, hashtag, text);
  }
  assert.deepEqual(readTrigger('#Approved Darnell #NotApproved Calvin 3 accidents').segments, [
    { decision: 'approved', text: 'Darnell' },
    { decision: 'not_approved', text: 'Calvin 3 accidents' },
  ]);
});

test('ONLY DECISIONS COST ANYTHING: chatter, files and reports are not decisions', () => {
  for (const text of ['#Approved', 'approved', 'clh sent Approved', 'Not approved', 'disapproved', 'is he approved?',
    'Looks good, we can hire him', "can't hire him, 3 accidents"]) {
    assert.equal(isDecisionMessage(text), true, text);
  }
  for (const text of ['on it', 'CLH sent', 'CLEAN', 'Done', 'Drug test all set', '', null]) {
    assert.equal(isDecisionMessage(text), false, String(text));
  }
  assert.equal(readTrigger('is he approved?').question, true);
});

test('the reason is Safety\'s words without the hashtag or the decision words', () => {
  assert.equal(reasonFrom('#NotApproved driver at fault'), 'driver at fault');
  assert.equal(reasonFrom('driver was at fault, not approved'), 'driver was at fault');
  assert.equal(reasonFrom('#Approved'), null);
  assert.equal(reasonFrom('Not approved.'), null);
  assert.equal(reasonFrom(`#NotApproved ${'x'.repeat(400)}`).length, 298);
});

test('names are read off a post without a model, in title case, as written', () => {
  assert.deepEqual(namesInPost('Company Driver - 80 CPM\n\nPHILLIPS SAMUEL JAHBARI  \n3+ yrs of exp\n(704) 493-1180'),
    ['Phillips Samuel Jahbari']);
  assert.deepEqual(namesInPost('Company driver 80 CPM\nEddie Watson\n(404) 555-0134\nexp over 2\n3 weeks OTR/3days home'),
    ['Eddie Watson']);
  assert.deepEqual(namesInPost('Company team drivers 95 CPM\nDarnell Brooks (main)\n(555) 010-2233\nCalvin Brooks'),
    ['Darnell Brooks', 'Calvin Brooks']);
  assert.deepEqual(namesInPost('Name: mary-jane o\'neil'), ['Mary-Jane O\'Neil']);
  for (const text of ['Joe Hardeman wanna come back asap', 'WENZE UNIT # 1407 USMON / ANVAR', 'Office is closed',
    'ready asap', 'no NY and NJ', '@gowenze good morning']) {
    assert.deepEqual(namesInPost(text), [], text);
  }
});

test('a person is named without the job title after the bar', () => {
  assert.equal(personName('Amelia Carter | Driver Relations'), 'Amelia Carter');
  assert.equal(personName(''), null);
});

const SOLO = [{ key: 'renata ilves', name: 'Renata Ilves' }];
const TEAM = [{ key: 'darnell brooks', name: 'Darnell Brooks' }, { key: 'calvin brooks', name: 'Calvin Brooks' }];
const decideFor = (text, candidates) => decideByHashtag(readTrigger(text).segments, candidates);

test('who a hashtag decides about — and when Safety must be asked instead', () => {
  assert.deepEqual(decideFor('#Approved', SOLO).decisions.map((d) => [d.name, d.decision]), [['Renata Ilves', 'approved']]);
  assert.equal(decideFor('#NotApproved Renata 3 accidents', SOLO).decisions[0].reason, '3 accidents');
  assert.deepEqual(decideFor('#Approved both', TEAM).decisions.map((d) => d.name), ['Darnell Brooks', 'Calvin Brooks']);
  assert.deepEqual(decideFor('#Approved', TEAM), { ask: 'which_of_team' });
  assert.deepEqual(decideFor('#Approved Brooks', TEAM), { ask: 'which_of_team' }, 'a shared surname names nobody');
  assert.deepEqual(decideFor('#Approved #NotApproved', SOLO), { ask: 'conflict' });
  assert.deepEqual(decideFor('#Approved', []), { ask: 'which_driver' });
});
