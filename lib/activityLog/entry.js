'use strict';

/**
 * One line of the activity log (Monitoring → Logs), built from what a Bitrix
 * write was asked and how it ended. PURE. docs/architecture/activity-log.md.
 *
 * The owner, 14 November 2026: Bitrix changed and nobody could say who, what
 * or why. So every WRITE either Bitrix client sends (services/
 * bitrix24DealStages.js `call`, services/bitrix24Service.js's lead creation)
 * is turned into one entry here — the record, the fields from → to, who
 * (a person's Telegram id, or "automatic" and the feature), why, and how it
 * ended. A read (`.get`, `.list`, `.fields`) is never an entry.
 *
 * WHAT AN ENTRY MAY NEVER HOLD: a secret (the webhook URL is the credential —
 * no URL survives `redactError` or a change value), a phone number, or chat
 * text. A driver's or candidate's NAME may be in `target_label` and in a
 * name field's from → to, and only for `NAME_DAYS`: retention takes it out
 * (`NAME_FIELDS`, `EVIDENCE_NAME_KEYS`) and the ids stay.
 */

const { stripUrls } = require('../security/redactUrls');

const RESULTS = Object.freeze(['done', 'refused', 'failed', 'already_done']);
const ACTOR_KINDS = Object.freeze(['person_button', 'person_reply', 'admin', 'automatic', 'unknown']);
/** Owner, 14 November 2026: entries are kept a year; names only 60 days. */
const KEEP_DAYS = 365;
const NAME_DAYS = 60;
const ERROR_MAX = 400;
const VALUE_MAX = 160;
const MAX_CHANGES = 12;

/** Change fields whose from → to is a person's name or a deal title. Upper case. */
const NAME_FIELDS = Object.freeze(['TITLE', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'FULL_NAME']);
/** Evidence keys that would hold a name, removed with `target_label` after 60 days. */
const EVIDENCE_NAME_KEYS = Object.freeze([
  'name', 'driverName', 'candidateName', 'displayName', 'title', 'dealTitle', 'targetLabel',
]);

/** Fields never copied into `change`: contact details, free text, our own stamps. */
const NEVER_SHOWN = /PHONE|EMAIL|^IM$|^WEB$|COMMENT|ADDRESS|ORIGIN|SOURCE_DESCRIPTION/i;

/**
 * ANY namespace, not only `crm.`: `tasks.task.add`, `im.notify.system.add` or
 * `user.update` changes Bitrix as surely as `crm.deal.update` does, and a
 * write the recorder does not recognise is a write that happens unseen.
 */
const WRITE_METHOD = /^([a-z0-9_]+(?:\.[a-z0-9_]+)*)\.(add|update|delete)$/i;
const VERB = Object.freeze({ add: 'create', update: 'update', delete: 'delete' });
/** The classic CRM records: an update answers `true`, an add the new id. */
const CLASSIC = new Set(['deal', 'contact', 'lead', 'company', 'quote', 'invoice']);

/** Whether a Bitrix REST method changes something (`*.add|update|delete`). */
function isBitrixWrite(method) {
  return WRITE_METHOD.test(String(method || ''));
}

/** `crm.deal.update` → deal / update; `tasks.task.add` → tasks.task / add. */
function parseMethod(method) {
  const m = WRITE_METHOD.exec(String(method || ''));
  if (!m) return null;
  const space = m[1].toLowerCase();
  return { entity: space.startsWith('crm.') ? space.slice(4) : space, verb: m[2].toLowerCase() };
}

/**
 * The id of a record a write created, from Bitrix's answer: a classic add
 * answers the id itself, `crm.item.add` answers `{item: {id}}`.
 */
function createdId(result) {
  const raw = result && typeof result === 'object' ? result.item?.id : result;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Whether Bitrix's answer confirms the write. A classic update / delete
 * answers exactly `true`; `crm.item.update` answers `{item: {...}}` and
 * `crm.item.delete` an empty answer; an add answers its new id. Any other
 * namespace: an answer that is not `false` or empty (a refusal is an HTTP
 * error, which the client throws).
 */
function confirmed(m, result) {
  if (m.verb === 'add' && (CLASSIC.has(m.entity) || m.entity === 'item')) return createdId(result) != null;
  if (CLASSIC.has(m.entity)) return result === true;
  if (m.entity === 'item') return m.verb === 'delete' ? result !== false : Boolean(result?.item && typeof result.item === 'object');
  return result != null && result !== false;
}

/** `deal.stage`, `deal.title`, `deal.fields`, `contact.create`, `lead.create`, `item.update`, … */
function actionFor(method, params) {
  const m = parseMethod(method);
  if (!m) return 'unknown';
  if (m.entity === 'deal' && m.verb === 'update') {
    const keys = Object.keys(params?.fields || {});
    if (keys.includes('STAGE_ID')) return 'deal.stage';
    if (keys.length === 1 && keys[0] === 'TITLE') return 'deal.title';
    return 'deal.fields';
  }
  return `${m.entity}.${VERB[m.verb]}`;
}

/** The record a write is about: its type, and its id (a new record's from Bitrix's answer). */
function targetFor(method, params, result) {
  const m = parseMethod(method);
  const type = m ? m.entity : null;
  const given = params?.id ?? params?.ID;
  if (given != null && String(given).trim() !== '') return { targetType: type, targetId: String(given) };
  const created = m?.verb === 'add' ? createdId(result) : null;
  if (created) return { targetType: type, targetId: String(created) };
  return { targetType: type, targetId: null };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBERISH = /\+?\(?\d[\d\s().-]{8,}\d/g;

/** A sentence with every URL, webhook path and phone-like number taken out. */
function scrubText(text) {
  const out = stripUrls(String(text ?? ''))
    .replace(/\brest\/\d+\/[A-Za-z0-9_]+/g, 'rest/<redacted>');
  if (ISO_DATE.test(out.trim())) return out;
  return out.replace(NUMBERISH, (m) => {
    const digits = m.replace(/\D/g, '').length;
    return digits >= 10 && digits <= 15 ? '[number removed]' : m;
  });
}

function clip(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A change value as text, or null. A list of scalars is joined; anything deeper is not shown. */
function cleanValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (!value.every((v) => v == null || typeof v !== 'object')) return null;
    return clip(scrubText(value.filter((v) => v != null).join(', ')), VALUE_MAX);
  }
  if (typeof value === 'object') return null;
  return clip(scrubText(value), VALUE_MAX);
}

/** A caller's `[{field, from, to}]`, cleaned; contact details and free text never pass. */
function normalizeChange(change) {
  if (!Array.isArray(change)) return [];
  return change
    .filter((c) => c && c.field && !NEVER_SHOWN.test(String(c.field)))
    .slice(0, MAX_CHANGES)
    .map((c) => ({ field: clip(String(c.field), 60), from: cleanValue(c.from), to: cleanValue(c.to) }));
}

/** What a write set, when the caller did not say: the fields sent, `from` unknown. */
function changeFromFields(fields) {
  return normalizeChange(Object.entries(fields || {}).map(([field, to]) => ({ field, from: null, to })));
}

/** Bitrix's words, safe to store and show: no URL, no credential, no phone, ≤ 400 characters. */
function redactError(text) {
  if (text == null || text === '') return null;
  return clip(scrubText(text).trim(), ERROR_MAX) || null;
}

/**
 * How a write that threw ended: Bitrix ANSWERED no (a 4xx, "access denied",
 * a refused field) is `refused`; no answer, a timeout, a 5xx, or Bitrix not
 * connected at all is `failed`.
 */
function resultOfError(err) {
  if (!err) return 'failed';
  if (err.retryable === true || err.reason === 'network_error' || err.reason === 'not_configured') return 'failed';
  return err.retryable === false ? 'refused' : 'failed';
}

const toId = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
};
const text = (v, max) => (v == null || String(v).trim() === '' ? null : clip(String(v).trim(), max));

/**
 * Ids only: each evidence value a scalar, at most 20 keys. Long numbers are
 * KEPT here — a Telegram chat id or a leadgen id is exactly the evidence — so
 * a caller never puts a phone number in evidence; URLs still go.
 */
function cleanEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return {};
  const out = {};
  for (const [k, v] of Object.entries(evidence).slice(0, 20)) {
    if (v == null) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v !== 'object') {
      out[k] = clip(stripUrls(String(v)).replace(/\brest\/\d+\/[A-Za-z0-9_]+/g, 'rest/<redacted>'), VALUE_MAX);
    }
  }
  return out;
}

/**
 * Who and why, from a caller's audit context. Anything missing or misspelt is
 * `unknown` — never a guess at a person.
 */
function normalizeAudit(audit) {
  const a = audit && typeof audit === 'object' ? audit : {};
  const kind = ACTOR_KINDS.includes(a.actorKind) ? a.actorKind : 'unknown';
  return {
    actorKind: kind,
    actorTelegramId: toId(a.actorTelegramId),
    actorAdminId: toId(a.actorAdminId),
    actorName: text(a.actorName, 120),
    trigger: text(a.trigger, 80),
    reason: text(a.reason, 300),
    evidence: cleanEvidence(a.evidence),
    targetLabel: text(a.targetLabel, 160),
    change: a.change === undefined ? undefined : normalizeChange(a.change),
    correlationKey: text(a.correlationKey, 200),
    attempt: Number.isInteger(a.attempt) && a.attempt > 0 ? a.attempt : null,
  };
}

/** The sentence an entry carries when no caller said who or why. */
const NO_CONTEXT_REASON = 'Recorded without a reason: the code that made this change did not say who or why.';

/**
 * The entry for one Bitrix write.
 * @param {{method: string, params: object, audit?: object|null, result?: *, error?: Error|null}} args
 */
function bitrixWriteEntry({
  method, params, audit = null, result, error = null,
}) {
  const who = normalizeAudit(audit);
  const { targetType, targetId } = targetFor(method, params, error ? null : result);
  const m = parseMethod(method);
  let outcome = 'done';
  let why = null;
  if (error) {
    outcome = resultOfError(error);
    why = redactError(error.message || String(error));
  } else if (!m || !confirmed(m, result)) {
    outcome = 'failed';
    why = m?.verb === 'add' ? 'Bitrix did not return the new record\'s id' : 'Bitrix did not confirm the change';
  }
  return {
    system: 'bitrix',
    action: actionFor(method, params),
    targetType,
    targetId,
    targetLabel: who.targetLabel,
    change: who.change !== undefined ? who.change : changeFromFields(params?.fields),
    actorKind: who.actorKind,
    actorTelegramId: who.actorTelegramId,
    actorAdminId: who.actorAdminId,
    actorName: who.actorName,
    trigger: who.trigger,
    reason: who.reason || (audit ? null : NO_CONTEXT_REASON),
    evidence: who.evidence,
    result: outcome,
    error: why,
    attempt: who.attempt,
    correlationKey: who.correlationKey,
    safetyCheck: false,
  };
}

/**
 * An attempt that never reached Bitrix's write — a safety check of ours
 * refused it (the Board changed, the deal moved, no such truck), it was
 * already as asked, or the read before it got no answer. Not a write, but the
 * owner wants every attempt in the timeline.
 *
 * `safetyCheck`: OUR check said no and nothing was sent to Bitrix. Such an
 * entry is in the timeline but is not Bitrix refusing or failing, so it never
 * counts toward the owner's failure notice (decision d). It defaults to true
 * for `refused` — the one thing an attempt is refused by is a check; an
 * attempt whose READ failed passes `attemptFromError(err)` instead.
 */
function attemptEntry({
  action, targetType = 'deal', targetId = null, audit = null, result = 'refused', error = null, system = 'bitrix',
  safetyCheck = result === 'refused',
}) {
  const who = normalizeAudit(audit);
  return {
    system,
    action: text(action, 60) || 'unknown',
    targetType,
    targetId: targetId == null ? null : String(targetId),
    targetLabel: who.targetLabel,
    change: who.change || [],
    actorKind: who.actorKind,
    actorTelegramId: who.actorTelegramId,
    actorAdminId: who.actorAdminId,
    actorName: who.actorName,
    trigger: who.trigger,
    reason: who.reason,
    evidence: who.evidence,
    result: RESULTS.includes(result) ? result : 'failed',
    error: redactError(error),
    attempt: who.attempt,
    correlationKey: who.correlationKey,
    safetyCheck: safetyCheck === true && result === 'refused',
  };
}

/**
 * The outcome of an attempt that threw before its write — Bitrix's read got
 * no answer (`failed`) or Bitrix said no to it (`refused`), never a safety
 * check of ours. Spread into `recordAttempt({...})`.
 */
function attemptFromError(err) {
  return {
    result: resultOfError(err),
    error: err?.message || String(err || 'unknown error'),
    safetyCheck: false,
  };
}

module.exports = {
  RESULTS,
  ACTOR_KINDS,
  KEEP_DAYS,
  NAME_DAYS,
  ERROR_MAX,
  NAME_FIELDS,
  EVIDENCE_NAME_KEYS,
  NO_CONTEXT_REASON,
  isBitrixWrite,
  actionFor,
  targetFor,
  normalizeChange,
  changeFromFields,
  redactError,
  resultOfError,
  normalizeAudit,
  bitrixWriteEntry,
  attemptEntry,
  attemptFromError,
};
