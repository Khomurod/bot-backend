'use strict';

/**
 * Where a CDL's values go in Bitrix, and what is said about it. Pure.
 * (Owner, 14 November 2026 — docs/architecture/hiring-cdl-reading.md.)
 *
 *   THE OWNER MAPS each CDL item to a Bitrix field — on the candidate's
 *     contact or on the deal — or leaves it unmapped (`hiring_cdl_field_map`).
 *     Offered: the user fields (`UF_*`) of a type a value can be written to,
 *     and a few standard contact fields (name, birth date, address), read
 *     live from `crm.contact.fields` / `crm.deal.fields`.
 *   A FIELD THAT ALREADY HAS A VALUE IS NEVER OVERWRITTEN. The same value is
 *     left alone; a different one goes into the comment, marked "not
 *     changed", so a person can compare.
 *   EVERYTHING NOT WRITTEN to a field — unmapped, a field gone from Bitrix,
 *     a value that does not fit the field (a height in a number field, a
 *     class no list item names) — goes into ONE timeline comment on the
 *     deal, titled "CDL (read by <provider/model>)".
 *   WHAT IS SAID ELSEWHERE carries no value: Monitoring → Logs gets the
 *     field NAMES with "set (from CDL)"; the driver's card in Telegram gets
 *     counts ("9 items written to Bitrix, 3 in a comment") or the reason.
 */

const { CDL_ITEMS, ITEM_KEYS, realDate, itemLabel } = require('./cdlFields');
const { esc } = require('./messages');

const WRITABLE_TYPES = new Set(['string', 'date', 'datetime', 'integer', 'double', 'enumeration']);
/** Standard fields a CDL item may go to (user fields `UF_*` are offered on both). */
const STANDARD = Object.freeze({
  contact: Object.freeze(['NAME', 'SECOND_NAME', 'LAST_NAME', 'BIRTHDATE', 'ADDRESS', 'ADDRESS_2', 'ADDRESS_CITY',
    'ADDRESS_REGION', 'ADDRESS_PROVINCE', 'ADDRESS_POSTAL_CODE', 'ADDRESS_COUNTRY']),
  deal: Object.freeze([]),
});
const ENTITIES = Object.freeze(['contact', 'deal']);
const FIELD_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** What Monitoring → Logs shows in place of a CDL value. */
const MASK = 'set (from CDL)';
const MASK_COMMENT = 'in the comment (from CDL)';

function mayTarget(entity, code) {
  return ENTITIES.includes(entity) && FIELD_CODE.test(code) && (code.startsWith('UF_') || STANDARD[entity].includes(code));
}

/** A label Bitrix sent: a string, or a map of languages. */
function labelOf(def, code) {
  for (const raw of [def.formLabel, def.listLabel, def.filterLabel, def.title]) {
    const value = raw && typeof raw === 'object' ? (raw.en || Object.values(raw)[0]) : raw;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return code;
}

/**
 * The fields of one `crm.<entity>.fields` answer the owner may pick.
 * @returns {{code, label, type, multiple}[]} by label
 */
function offerableFields(entity, answer) {
  return Object.entries(answer && typeof answer === 'object' ? answer : {})
    .filter(([code, def]) => def && !def.isReadOnly && WRITABLE_TYPES.has(def.type) && mayTarget(entity, code))
    .map(([code, def]) => ({
      code, label: labelOf(def, code), type: def.type, multiple: def.isMultiple === true,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.code.localeCompare(b.code));
}

/**
 * The mapping a person saved, checked: every item known, a field it may go
 * to, no item twice and no field twice. Rows without a field are unmapped.
 * @returns {{ok: true, mapping: object[]} | {ok: false, error: string}}
 */
function normaliseMapping(input) {
  if (!Array.isArray(input)) return { ok: false, error: 'The mapping must be a list.' };
  const mapping = [];
  for (const row of input) {
    const item = String(row?.item || '');
    const fieldCode = String(row?.fieldCode || '').trim();
    if (!ITEM_KEYS.includes(item)) return { ok: false, error: `"${item}" is not a CDL item.` };
    if (!fieldCode) continue;
    if (!mayTarget(row.entity, fieldCode)) return { ok: false, error: `${itemLabel(item)}: that Bitrix field cannot be used.` };
    if (mapping.some((m) => m.item === item)) return { ok: false, error: `${itemLabel(item)} is mapped twice.` };
    if (mapping.some((m) => m.entity === row.entity && m.fieldCode === fieldCode)) {
      return { ok: false, error: `Two CDL items go to the same Bitrix field (${fieldCode}).` };
    }
    mapping.push({
      item,
      entity: row.entity,
      fieldCode,
      fieldLabel: row.fieldLabel ? String(row.fieldLabel).slice(0, 200) : null,
      fieldType: row.fieldType ? String(row.fieldType).slice(0, 40) : null,
    });
  }
  return { ok: true, mapping };
}

const fold = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

/** The value as this field takes it, or null when it does not fit. */
function bitrixValue(def, value) {
  let out = null;
  if (def.type === 'date' || def.type === 'datetime') out = realDate(value);
  else if (def.type === 'integer' || def.type === 'double') {
    const m = /^(\d+(?:\.\d+)?)(?:\s*(?:lb|kg|cm|in))?$/i.exec(String(value));
    if (m && (def.type === 'double' || Number.isInteger(Number(m[1])))) out = Number(m[1]);
  } else if (def.type === 'enumeration') {
    const hit = (Array.isArray(def.items) ? def.items : []).find((it) => fold(it?.VALUE) === fold(value));
    out = hit ? String(hit.ID) : null;
  } else out = String(value);
  if (out === null) return null;
  return def.isMultiple ? [out] : out;
}

function isEmpty(v) {
  if (v == null || v === '' || v === false) return true;
  if (Array.isArray(v)) return v.every(isEmpty);
  return typeof v === 'object' && !Object.keys(v).length;
}

function sameValue(current, wanted) {
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const a = fold(first(current));
  const b = fold(first(wanted));
  return a === b || (/^\d{4}-\d{2}-\d{2}/.test(a) && a.slice(0, 10) === b.slice(0, 10));
}

/**
 * What to write where.
 * @param {object} args
 * @param {object} args.values     the checked CDL values (lib/hiringStages/cdlFields.js)
 * @param {object[]} args.mapping  the owner's mapping
 * @param {{contact?: object, deal?: object}} args.defs     `crm.<entity>.fields` answers
 * @param {{contact?: object|null, deal?: object|null}} args.current  the records as Bitrix has them now
 * @returns {{updates: {contact: object, deal: object}, written: object[], comment: object[], same: string[]}}
 */
function planCdlWrite({
  values, mapping = [], defs = {}, current = {},
}) {
  const updates = { contact: {}, deal: {} };
  const written = [];
  const comment = [];
  const same = [];
  for (const { key: item } of CDL_ITEMS) {
    const value = values?.[item];
    if (value == null) continue;
    const m = mapping.find((row) => row.item === item);
    const record = m ? current[m.entity] : null;
    const def = m ? defs[m.entity]?.[m.fieldCode] : null;
    const why = (() => {
      if (!m) return 'unmapped';
      if (!record) return 'no_record';
      if (!def || def.isReadOnly || m.fieldCode in updates[m.entity]) return 'no_field';
      return null;
    })();
    const wanted = why ? null : bitrixValue(def, value);
    if (why || wanted === null) {
      comment.push({ item, value, why: why || 'not_fit' });
    } else if (!isEmpty(record[m.fieldCode])) {
      if (sameValue(record[m.fieldCode], wanted)) same.push(item);
      else comment.push({ item, value, why: 'filled' });
    } else {
      updates[m.entity][m.fieldCode] = wanted;
      written.push({ item, entity: m.entity, fieldCode: m.fieldCode });
    }
  }
  return {
    updates, written, comment, same,
  };
}

/** The ONE timeline comment: its title, which photo was which, then each value not written to a field. */
function commentText({
  providerKey, model, front, back, lines,
}) {
  const head = `CDL (read by ${providerKey || 'AI'}/${model || 'unknown model'})`;
  const photos = `Front: photo ${front}${back ? `, back: photo ${back}` : ''} of the post in the recruiting group.`;
  const body = lines.map(({ item, value, why }) => `${itemLabel(item)}: ${value}`
    + (why === 'filled' ? ' (Bitrix already had another value — not changed)' : ''));
  return [head, photos, ...body].join('\n');
}

/** Monitoring → Logs: the field names, never a value. */
function maskedChange(fieldCodes) {
  return fieldCodes.map((field) => ({ field, from: null, to: MASK }));
}

function maskedCommentChange(items) {
  return items.map((item) => ({ field: `cdl:${item}`, from: null, to: MASK_COMMENT }));
}

const items = (n) => `${n} item${n === 1 ? '' : 's'}`;

/**
 * The driver's card line — counts or a reason, never a value.
 * @param {{status: string, providerLabel?: string, written?: number, inComment?: number, nameFromCdl?: boolean}} o
 */
function cdlLine(o) {
  const by = esc(o.providerLabel || 'AI');
  const n = Number(o.written) || 0;
  const c = Number(o.inComment) || 0;
  switch (o.status) {
    case 'written': {
      const what = n || c ? `${items(n)} written to Bitrix, ${c} in a comment` : 'nothing new — Bitrix already had it';
      return `🪪 CDL read (${by}): ${what}${o.nameFromCdl ? ' — name read from the CDL' : ''}`;
    }
    case 'name_differs': return '🪪 The CDL name differs from the post — nothing from the CDL was written';
    case 'unsure': return `🪪 CDL not written: ${by} was not sure — nothing from it was written`;
    case 'unreadable': return '🪪 CDL not read: the photos (or the name on the CDL) could not be read';
    case 'no_photo': return '🪪 CDL not read: the post has no photo';
    case 'off': return '🪪 CDL not read: reading CDL photos is switched off (Settings → AI)';
    case 'no_provider': return '🪪 CDL not read: no AI provider is chosen for it, or none of those chosen can be asked (Settings → AI)';
    case 'no_deal': return '🪪 CDL read, but nothing was written: there is no open deal to write it to';
    case 'not_hiring': return '🪪 CDL not written: the deal is not in a hiring pipeline';
    case 'team': return '🪪 CDL not read: the post may be about more than one driver';
    case 'bitrix_refused': return `🪪 CDL read (${by}), but Bitrix refused or did not answer — ${items(n)} written before that`;
    default: return null;
  }
}

module.exports = {
  STANDARD, MASK, offerableFields, normaliseMapping, mayTarget, bitrixValue, planCdlWrite, commentText,
  maskedChange, maskedCommentChange, cdlLine,
};
