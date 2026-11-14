'use strict';

/**
 * lib/hiringStages/cdlWrite.js — where a CDL's values go in Bitrix (owner,
 * 14 November 2026). A field that already has a value is NEVER overwritten;
 * everything not written to a field goes into ONE comment; what Telegram and
 * Monitoring → Logs are told carries no value. Every value here is made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('../lib/hiringStages/cdlWrite');

const DEFS = {
  contact: {
    ID: { type: 'integer', isReadOnly: true, title: 'ID' },
    NAME: { type: 'string', title: 'Name' },
    LAST_NAME: { type: 'string', title: 'Last name' },
    BIRTHDATE: { type: 'date', title: 'Date of birth' },
    PHONE: { type: 'crm_multifield', isMultiple: true, title: 'Phone' },
    ASSIGNED_BY_ID: { type: 'user', title: 'Responsible' },
    UF_CRM_CDL_NO: { type: 'string', title: 'UF_CRM_CDL_NO', formLabel: 'CDL number', listLabel: 'CDL #' },
    UF_CRM_WEIGHT: { type: 'integer', title: 'UF_CRM_WEIGHT', formLabel: { en: 'Weight, lb', ru: 'Вес' } },
    UF_CRM_LOCKED: { type: 'string', isReadOnly: true, title: 'UF_CRM_LOCKED', formLabel: 'Locked' },
    UF_CRM_FILE: { type: 'file', title: 'UF_CRM_FILE', formLabel: 'CDL scan' },
  },
  deal: {
    TITLE: { type: 'string', title: 'Name' },
    UF_CRM_CLASS: {
      type: 'enumeration', title: 'UF_CRM_CLASS', formLabel: 'CDL class', items: [{ ID: '71', VALUE: 'A' }, { ID: '72', VALUE: 'B' }],
    },
    UF_CRM_EXP: { type: 'date', title: 'UF_CRM_EXP', formLabel: 'CDL expires' },
    UF_CRM_ENDORSE: { type: 'string', isMultiple: true, title: 'UF_CRM_ENDORSE', formLabel: 'Endorsements' },
  },
};
const MAPPING = [
  { item: 'date_of_birth', entity: 'contact', fieldCode: 'BIRTHDATE' },
  { item: 'license_number', entity: 'contact', fieldCode: 'UF_CRM_CDL_NO' },
  { item: 'weight', entity: 'contact', fieldCode: 'UF_CRM_WEIGHT' },
  { item: 'license_class', entity: 'deal', fieldCode: 'UF_CRM_CLASS' },
  { item: 'expiration_date', entity: 'deal', fieldCode: 'UF_CRM_EXP' },
  { item: 'endorsements', entity: 'deal', fieldCode: 'UF_CRM_ENDORSE' },
  { item: 'height', entity: 'contact', fieldCode: 'UF_CRM_GONE' },
];
const VALUES = {
  first_name: 'Kwame', last_name: 'Asante', date_of_birth: '1988-04-12', license_number: 'A1234567',
  weight: '180 lb', license_class: 'A', expiration_date: '2030-04-12', endorsements: 'H N', height: '5\'10"',
  eye_color: 'BRO',
};

test('the fields offered: writable user fields of a usable type, and a few standard contact fields, by label', () => {
  const contact = W.offerableFields('contact', DEFS.contact);
  assert.deepEqual(contact.map((f) => f.code), ['UF_CRM_CDL_NO', 'BIRTHDATE', 'LAST_NAME', 'NAME', 'UF_CRM_WEIGHT']);
  assert.equal(contact[0].label, 'CDL number', 'the form label, not the code');
  assert.equal(contact.find((f) => f.code === 'UF_CRM_WEIGHT').label, 'Weight, lb', 'a label per language');
  const deal = W.offerableFields('deal', DEFS.deal);
  assert.deepEqual(deal.map((f) => f.code), ['UF_CRM_CLASS', 'UF_CRM_EXP', 'UF_CRM_ENDORSE'], 'TITLE is not offered');
  assert.deepEqual(W.offerableFields('deal', null), []);
});

test('a saved mapping is checked: known items, usable fields, nothing twice', () => {
  assert.deepEqual(W.normaliseMapping([{ item: 'date_of_birth', entity: 'contact', fieldCode: 'BIRTHDATE' },
    { item: 'sex', entity: 'deal', fieldCode: '' }]).mapping.map((m) => m.item), ['date_of_birth'], 'no field: unmapped');
  assert.match(W.normaliseMapping([{ item: 'ssn', entity: 'contact', fieldCode: 'UF_CRM_X' }]).error, /not a CDL item/);
  assert.match(W.normaliseMapping([{ item: 'sex', entity: 'contact', fieldCode: 'PHONE' }]).error, /cannot be used/);
  assert.match(W.normaliseMapping([{ item: 'sex', entity: 'deal', fieldCode: 'TITLE' }]).error, /cannot be used/);
  assert.match(W.normaliseMapping([{ item: 'sex', entity: 'lead', fieldCode: 'UF_CRM_X' }]).error, /cannot be used/);
  assert.match(W.normaliseMapping([{ item: 'sex', entity: 'deal', fieldCode: 'uf_crm_x' }]).error, /cannot be used/);
  assert.match(W.normaliseMapping([
    { item: 'sex', entity: 'deal', fieldCode: 'UF_CRM_X' }, { item: 'height', entity: 'deal', fieldCode: 'UF_CRM_X' },
  ]).error, /same Bitrix field/);
  assert.match(W.normaliseMapping('nope').error, /must be a list/);
});

test('EMPTY mapped fields are written, each in its type; the rest go to the comment', () => {
  const plan = W.planCdlWrite({
    values: VALUES, mapping: MAPPING, defs: DEFS,
    current: { contact: { ID: '7', NAME: 'Kwame', LAST_NAME: 'Asante', BIRTHDATE: '', UF_CRM_CDL_NO: null, UF_CRM_WEIGHT: '' },
      deal: { ID: '9', UF_CRM_CLASS: '', UF_CRM_EXP: '', UF_CRM_ENDORSE: [] } },
  });
  assert.deepEqual(plan.updates, {
    contact: { BIRTHDATE: '1988-04-12', UF_CRM_CDL_NO: 'A1234567', UF_CRM_WEIGHT: 180 },
    deal: { UF_CRM_CLASS: '71', UF_CRM_EXP: '2030-04-12', UF_CRM_ENDORSE: ['H N'] },
  });
  assert.deepEqual(plan.written.map((w) => w.item),
    ['date_of_birth', 'license_number', 'license_class', 'expiration_date', 'endorsements', 'weight']);
  assert.deepEqual(plan.comment.map((c) => `${c.item}:${c.why}`),
    ['first_name:unmapped', 'last_name:unmapped', 'height:no_field', 'eye_color:unmapped']);
});

test('A FILLED FIELD IS NEVER OVERWRITTEN: the same value is left alone, a different one goes to the comment', () => {
  const plan = W.planCdlWrite({
    values: VALUES, mapping: MAPPING, defs: DEFS,
    current: {
      contact: { BIRTHDATE: '1988-04-12T03:00:00+03:00', UF_CRM_CDL_NO: 'B999', UF_CRM_WEIGHT: '0' },
      deal: { UF_CRM_CLASS: '72', UF_CRM_EXP: '2030-04-12', UF_CRM_ENDORSE: ['H N'] },
    },
  });
  assert.deepEqual(plan.updates, { contact: {}, deal: {} }, 'nothing is written over a value');
  assert.deepEqual(plan.same.sort(), ['date_of_birth', 'endorsements', 'expiration_date']);
  assert.deepEqual(plan.comment.filter((c) => c.why === 'filled').map((c) => c.item).sort(),
    ['license_class', 'license_number', 'weight']);
  const text = W.commentText({
    providerKey: 'anthropic', model: 'claude-sonnet-4-5', front: 1, back: 2, lines: plan.comment,
  });
  assert.match(text, /^CDL \(read by anthropic\/claude-sonnet-4-5\)\nFront: photo 1, back: photo 2 of the post/);
  assert.match(text, /\nLicence number: A1234567 \(Bitrix already had another value — not changed\)/);
  assert.match(text, /\nFirst name: Kwame\n/);
});

test('a value that does not fit its field goes to the comment; no record, no field: the comment too', () => {
  const plan = W.planCdlWrite({
    values: { license_class: 'C', weight: '82 kg', height: '5\'10"' },
    mapping: [
      { item: 'license_class', entity: 'deal', fieldCode: 'UF_CRM_CLASS' },
      { item: 'weight', entity: 'contact', fieldCode: 'UF_CRM_WEIGHT' },
      { item: 'height', entity: 'contact', fieldCode: 'UF_CRM_WEIGHT_2' },
    ],
    defs: { ...DEFS, contact: { ...DEFS.contact, UF_CRM_WEIGHT_2: { type: 'integer' } } },
    current: { contact: null, deal: { UF_CRM_CLASS: '' } },
  });
  assert.deepEqual(plan.comment.map((c) => `${c.item}:${c.why}`),
    ['license_class:not_fit', 'height:no_record', 'weight:no_record']);
  assert.deepEqual(plan.written, []);
});

test('Monitoring → Logs gets field NAMES, never a CDL value', () => {
  assert.deepEqual(W.maskedChange(['BIRTHDATE', 'UF_CRM_CDL_NO']), [
    { field: 'BIRTHDATE', from: null, to: 'set (from CDL)' }, { field: 'UF_CRM_CDL_NO', from: null, to: 'set (from CDL)' },
  ]);
  assert.deepEqual(W.maskedCommentChange(['height']), [{ field: 'cdl:height', from: null, to: 'in the comment (from CDL)' }]);
});

test('the driver\'s card says counts or the reason — never a value', () => {
  assert.equal(W.cdlLine({ status: 'written', providerLabel: 'Claude', written: 9, inComment: 3 }),
    '🪪 CDL read (Claude): 9 items written to Bitrix, 3 in a comment');
  assert.equal(W.cdlLine({ status: 'written', providerLabel: 'Gemini', written: 1, inComment: 0, nameFromCdl: true }),
    '🪪 CDL read (Gemini): 1 item written to Bitrix, 0 in a comment — name read from the CDL');
  assert.match(W.cdlLine({ status: 'written', providerLabel: 'Claude' }), /nothing new/);
  assert.equal(W.cdlLine({ status: 'name_differs' }), '🪪 The CDL name differs from the post — nothing from the CDL was written');
  assert.match(W.cdlLine({ status: 'off' }), /switched off/);
  assert.match(W.cdlLine({ status: 'no_provider' }), /no AI provider is chosen/);
  assert.match(W.cdlLine({ status: 'no_photo' }), /no photo/);
  assert.match(W.cdlLine({ status: 'unsure', providerLabel: 'Claude' }), /Claude was not sure/);
  assert.match(W.cdlLine({ status: 'bitrix_refused', providerLabel: 'Claude', written: 2 }), /Bitrix refused or did not answer — 2 items/);
  assert.match(W.cdlLine({ status: 'written', providerLabel: '<b>x</b>' }), /&lt;b&gt;/, 'escaped');
  assert.equal(W.cdlLine({ status: 'whatever' }), null);
});
