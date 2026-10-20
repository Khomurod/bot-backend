'use strict';

/**
 * The gate in front of the annotator's model: only a message that may be about
 * leaving the company is read by AI (owner's decision, October 2026). Recall
 * over precision — a cue only buys a model call; a missed one is a driver
 * nobody rings.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mentionsLeaving, splitByLeavingCue, unreadAnnotation, KEYWORD_SKIP_VERSION,
} = require('../services/retention/leavingCue');

test('a driver saying they are leaving is read, in all three languages', () => {
  for (const text of [
    'I quit, this is my last load',
    'Giving my two weeks notice today',
    "I'm leaving the company next Friday",
    'Found another company with better miles',
    'Where do I drop off the truck?',
    'Я ухожу из компании',
    'Увольняюсь, это последний рейс',
    'Перехожу в другую компанию',
    'Где сдать трак?',
    'Men ketaman, oxirgi reys',
    'Boshqa kompaniyaga o‘taman',
    'Ishdan bo‘shayman',
    'Мен кетаман',
    'Бошқа компанияга ўтаман',
  ]) {
    assert.equal(mentionsLeaving(text), true, text);
  }
});

test('ordinary traffic costs no model call', () => {
  for (const text of [
    'Status: Home',
    'Status: on the road',
    'Picked up, heading to Dallas, ETA 6pm',
    'Can I get home time on the 25th?',
    'Отправил фото BOL',
    'Yukni oldim, yo‘ldaman',
    'ok',
    '',
    null,
  ]) {
    assert.equal(mentionsLeaving(text), false, String(text));
  }
});

test('the split keeps every message — read or recorded, never dropped', () => {
  const logs = [
    { id: 1, message_text: 'I quit' },
    { id: 2, message_text: 'ETA 5pm' },
    { id: 3, message_text: 'Увольняюсь' },
  ];
  const { toRead, skipped } = splitByLeavingCue(logs);
  assert.deepEqual(toRead.map((l) => l.id), [1, 3]);
  assert.deepEqual(skipped.map((l) => l.id), [2]);
});

test('an unread message is no_signal and claims NOTHING else', () => {
  // "Not read" must never look like "read and found neutral": retention's
  // sentiment average counts only non-null values.
  const a = unreadAnnotation(7);
  assert.equal(a.id, 7);
  assert.equal(a.intent, 'no_signal');
  for (const k of ['language', 'sentiment', 'urgency', 'role', 'role_confidence', 'entities']) {
    assert.equal(a[k], null, k);
  }
  assert.match(KEYWORD_SKIP_VERSION, /prefilter/);
});
