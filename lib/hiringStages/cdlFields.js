'use strict';

/**
 * What is printed on a CDL, and what a model's reading of one may be trusted
 * to say. Pure — the day is passed in.
 *
 * THE OWNER'S DECISION (14 November 2026): when a person tags the bot under a
 * lead's post, a vision model reads EVERYTHING printed on the CDL and the
 * values go to Bitrix (docs/architecture/hiring-cdl-reading.md). A wrong value
 * in a candidate's record is worse than an empty field, so:
 *
 *   - the model is asked for ONE strict JSON shape (`ANSWER_SHAPE`), every
 *     item a string or null;
 *   - EVERY value is checked by its type here — a real calendar date, a
 *     licence number of letters, digits and dashes, a state of two letters, a
 *     ZIP of five or nine digits, a height a person can have — and a value
 *     that does not fit is DROPPED, never repaired into something else;
 *   - a key the shape does not have is dropped; a missing or illegible item
 *     is simply absent — nothing is ever invented;
 *   - an answer that says it is unsure (`unclear`) reads as `unsure`, and the
 *     caller writes NOTHING (docs/architecture/ai-decisions.md rule 7).
 *
 * The values exist only in memory, on their way to Bitrix: nothing here is
 * stored, logged or posted.
 */

const { titleCase } = require('../safetyApprovals/postDetails');

/** One entry per item printed on a CDL, in the order a person reads the card. */
const CDL_ITEMS = Object.freeze([
  { key: 'first_name', label: 'First name', kind: 'name' },
  { key: 'middle_name', label: 'Middle name', kind: 'name' },
  { key: 'last_name', label: 'Last name', kind: 'name' },
  { key: 'suffix', label: 'Suffix', kind: 'suffix' },
  { key: 'date_of_birth', label: 'Date of birth', kind: 'date' },
  { key: 'address_street', label: 'Street address', kind: 'street' },
  { key: 'address_city', label: 'City', kind: 'city' },
  { key: 'address_state', label: 'State (address)', kind: 'state' },
  { key: 'address_zip', label: 'ZIP code', kind: 'zip' },
  { key: 'license_number', label: 'Licence number', kind: 'licence' },
  { key: 'license_state', label: 'Issuing state', kind: 'state' },
  { key: 'license_class', label: 'Class', kind: 'class' },
  { key: 'issue_date', label: 'Issue date', kind: 'date' },
  { key: 'expiration_date', label: 'Expiration date', kind: 'date' },
  { key: 'endorsements', label: 'Endorsements', kind: 'codes' },
  { key: 'restrictions', label: 'Restrictions', kind: 'codes' },
  { key: 'sex', label: 'Sex', kind: 'sex' },
  { key: 'height', label: 'Height', kind: 'height' },
  { key: 'weight', label: 'Weight', kind: 'weight' },
  { key: 'eye_color', label: 'Eye colour', kind: 'eyes' },
  { key: 'hair_color', label: 'Hair colour', kind: 'hair' },
]);
const BY_KEY = new Map(CDL_ITEMS.map((i) => [i.key, i]));
const ITEM_KEYS = Object.freeze(CDL_ITEMS.map((i) => i.key));

/** The answer the model is asked for — the same keys, every value a string or null. */
const ANSWER_SHAPE = {
  is_cdl: 'true when one of the photos is the front of a driver\'s licence (CDL)',
  front_photo: 'the photo NUMBER showing the CDL\'s front, or null',
  back_photo: 'the photo NUMBER showing the CDL\'s back, or null',
  unclear: 'true when the photos show more than one person\'s licence or you cannot read it with confidence',
  confidence: '0-100',
  fields: Object.fromEntries(ITEM_KEYS.map((k) => [k, 'string or null'])),
};

/** US states, DC and the territories, and Canada's provinces (cross-border drivers). */
const STATES = new Set(`AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM
  NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP
  AB BC MB NB NL NS NT NU ON PE QC SK YT`.split(/\s+/));
const SUFFIXES = new Map([['JR', 'Jr'], ['SR', 'Sr'], ['II', 'II'], ['III', 'III'], ['IV', 'IV'], ['V', 'V']]);
/** AAMVA eye and hair codes, and the words a model may write instead. */
const EYES = new Set(['BLK', 'BLU', 'BRO', 'BRN', 'GRY', 'GRN', 'HAZ', 'MAR', 'PNK', 'DIC']);
const HAIR = new Set(['BAL', 'BLK', 'BLN', 'BRO', 'BRN', 'GRY', 'RED', 'SDY', 'WHI']);
const COLOUR_WORDS = new Map([
  ['BLACK', 'BLK'], ['BLUE', 'BLU'], ['BROWN', 'BRO'], ['GRAY', 'GRY'], ['GREY', 'GRY'], ['GREEN', 'GRN'],
  ['HAZEL', 'HAZ'], ['MAROON', 'MAR'], ['PINK', 'PNK'], ['BALD', 'BAL'], ['BLOND', 'BLN'], ['BLONDE', 'BLN'],
  ['RED', 'RED'], ['AUBURN', 'RED'], ['SANDY', 'SDY'], ['WHITE', 'WHI'],
]);

const text = (v) => String(v).replace(/\s+/g, ' ').trim();
const upper = (v) => text(v).toUpperCase();

/** "YYYY-MM-DD" of a real calendar day between 1900 and 2100, or null. */
function realDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100) return null;
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  return m[0];
}

const yearsBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / (365.25 * 86400000);

function name(value) {
  const t = text(value);
  if (t.length < 1 || t.length > 40 || !/\p{L}/u.test(t) || !/^[\p{L}][\p{L} .'’-]*$/u.test(t)) return null;
  return t.split(' ').map((w) => titleCase(w)).join(' ');
}

function heightOf(value) {
  const t = upper(value).replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  const feet = /^(\d)\s*(?:'|FT|-)\s*-?\s*(\d{1,2})\s*(?:"|''|IN)?$/.exec(t);
  if (feet) {
    const [f, i] = [Number(feet[1]), Number(feet[2])];
    return f >= 4 && f <= 7 && i <= 11 ? `${f}'${i}"` : null;
  }
  const metric = /^(\d{3})\s*CM$/.exec(t);
  if (metric) return Number(metric[1]) >= 120 && Number(metric[1]) <= 230 ? `${Number(metric[1])} cm` : null;
  const inches = /^(\d{2})\s*IN$/.exec(t);
  return inches && Number(inches[1]) >= 48 && Number(inches[1]) <= 90 ? `${Number(inches[1])} in` : null;
}

function weightOf(value) {
  const m = /^(\d{2,3})\s*(LBS?|LB\.|KG)?$/.exec(upper(value));
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === 'KG') return n >= 35 && n <= 230 ? `${n} kg` : null;
  return n >= 80 && n <= 500 ? `${n} lb` : null;
}

function codesOf(value) {
  const t = upper(value);
  if (t === 'NONE' || t === 'N/A' || t === 'NA') return 'NONE';
  const codes = t.split(/[\s,;/]+/).filter(Boolean);
  if (!codes.length || codes.length > 12 || !codes.every((c) => /^[A-Z0-9]{1,3}$/.test(c))) return null;
  return [...new Set(codes)].join(' ');
}

function colourOf(value, allowed) {
  const t = upper(value);
  const code = COLOUR_WORDS.get(t) || t;
  return allowed.has(code) ? code : null;
}

/** Each kind's check: the value as written to Bitrix, or null to drop it. */
const CHECKS = {
  name,
  suffix: (v) => SUFFIXES.get(upper(v).replace(/\.$/, '')) || null,
  date: realDate,
  street: (v) => {
    const t = upper(v);
    return t.length >= 3 && t.length <= 80 && /[A-Z]/.test(t) && /^[A-Z0-9 .,#'/-]+$/.test(t) ? t : null;
  },
  city: (v) => {
    const t = upper(v);
    return t.length >= 2 && t.length <= 40 && /^[A-Z][A-Z .'-]*$/.test(t) ? t : null;
  },
  state: (v) => (STATES.has(upper(v)) ? upper(v) : null),
  zip: (v) => {
    const t = upper(v);
    if (/^\d{5}(-\d{4})?$/.test(t)) return t;
    if (/^\d{9}$/.test(t)) return `${t.slice(0, 5)}-${t.slice(5)}`;
    return /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(t) ? t : null;
  },
  licence: (v) => {
    const t = upper(v).replace(/ /g, '');
    return /^[A-Z0-9](?:[A-Z0-9-]{2,18})[A-Z0-9]$/.test(t) && /\d/.test(t) && !/--/.test(t) ? t : null;
  },
  class: (v) => {
    const t = upper(v).replace(/^(?:CLASS|CDL)\s*/, '');
    return /^[A-Z]{1,2}\d?$/.test(t) ? t : null;
  },
  codes: codesOf,
  sex: (v) => ({
    M: 'M', F: 'F', X: 'X', MALE: 'M', FEMALE: 'F',
  }[upper(v)] || null),
  height: heightOf,
  weight: weightOf,
  eyes: (v) => colourOf(v, EYES),
  hair: (v) => colourOf(v, HAIR),
};

/** Dates that contradict each other are both dropped — which one is wrong is not guessed. */
function crossCheck(values, today) {
  const out = { ...values };
  const drop = (...keys) => keys.forEach((k) => delete out[k]);
  const dob = out.date_of_birth;
  if (dob && (dob >= today || yearsBetween(dob, today) < 16 || yearsBetween(dob, today) > 100)) drop('date_of_birth');
  if (out.issue_date && out.issue_date > today) drop('issue_date');
  if (out.expiration_date && yearsBetween(today, out.expiration_date) > 15) drop('expiration_date');
  if (out.issue_date && out.expiration_date && out.issue_date >= out.expiration_date) drop('issue_date', 'expiration_date');
  if (out.date_of_birth && out.issue_date && yearsBetween(out.date_of_birth, out.issue_date) < 14) {
    drop('date_of_birth', 'issue_date');
  }
  return out;
}

const photoNumber = (v, count) => (Number.isInteger(v) && v >= 1 && v <= count ? v : null);

/**
 * A model's reading, checked.
 * @param {*} parsed   the JSON the model answered
 * @param {{photoCount: number, today: string}} ctx  how many photos it was shown; today as YYYY-MM-DD
 * @returns {{status: 'read'|'unsure'|'not_cdl'|'unreadable', values: object, dropped: string[],
 *   front: number|null, back: number|null}}
 */
function readCdlAnswer(parsed, { photoCount, today }) {
  const none = (status) => ({
    status, values: {}, dropped: [], front: null, back: null,
  });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none('unreadable');
  if (parsed.unclear === true) return none('unsure');
  const front = photoNumber(parsed.front_photo, photoCount);
  if (parsed.is_cdl !== true || front === null) return none('not_cdl');
  const back = photoNumber(parsed.back_photo, photoCount);
  const fields = parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields) ? parsed.fields : null;
  if (!fields) return none('unreadable');

  const values = {};
  const dropped = [];
  for (const [key, raw] of Object.entries(fields)) {
    const item = BY_KEY.get(key);
    if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) continue;
    const checked = item && typeof raw === 'string' ? CHECKS[item.kind](raw) : null;
    if (checked) values[key] = checked;
    else dropped.push(item ? key : 'extra');
  }
  const kept = crossCheck(values, today);
  for (const key of Object.keys(values)) if (!(key in kept)) dropped.push(key);
  return {
    status: Object.keys(kept).length ? 'read' : 'unreadable',
    values: kept,
    dropped,
    front,
    back: back === front ? null : back,
  };
}

/** The CDL's name as one line: "First Middle Last Suffix", or null without a first and a last name. */
function cdlFullName(values) {
  if (!values?.first_name || !values?.last_name) return null;
  return [values.first_name, values.middle_name, values.last_name, values.suffix].filter(Boolean).join(' ');
}

function itemLabel(key) {
  return BY_KEY.get(key)?.label || key;
}

module.exports = {
  CDL_ITEMS, ITEM_KEYS, ANSWER_SHAPE, STATES, readCdlAnswer, realDate, cdlFullName, itemLabel,
};
