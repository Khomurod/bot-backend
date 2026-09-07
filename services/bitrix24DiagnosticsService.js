'use strict';

/**
 * "Is Bitrix actually wired up right?" — answered as steps, in production.
 *
 * WHY THIS EXISTS. Bitrix used to be fire-and-forget: a lead was posted to
 * `crm.lead.add` and whatever came back was recorded on the `leads` row. That
 * was tolerable while Bitrix was a second destination. It stopped being
 * tolerable when the lead's ASSIGNEE became the thing that decides WHICH
 * RECRUITER'S NUMBER texts the driver (services/facebookLeadSmsSender.js): a
 * portal that never assigns, an unmapped Bitrix user, or a field map that
 * matches nothing now degrades SMS sending, silently, and the only evidence is
 * a fallback note in a Telegram thread.
 *
 * So this reports the same chain the lead flow depends on, in order, the way
 * the RingCentral per-number Diagnose does: configuration → reachable and
 * scoped → the assignee readback the sender needs → who that assignee maps to
 * → whether the field map can store the form's answers → what has actually
 * happened to recent leads.
 *
 * NEVER RETURNS THE WEBHOOK URL. The Bitrix inbound webhook's secret IS its
 * URL, so only the host is ever reported.
 */
const rc = require('../database/ringcentral');
const {
  isBitrixConfigured,
  getBitrixMapperConfig,
  getWebhookBase,
  loadBitrixFieldCatalog,
  getCrmRecordAssignee,
  getConvertedDealAssignee,
} = require('./bitrix24Service');
const { resolveFieldMapConfig, loadBitrixFieldMapConfig } = require('./bitrix24FieldMapLoader');
const { findFieldByTitleHints } = require('./bitrix24FieldCatalog');

/** The host only — the path carries the secret. */
async function webhookHost() {
  const base = await getWebhookBase();
  if (!base) return '';
  try {
    return new URL(base).host;
  } catch {
    return 'unparseable';
  }
}

function step(steps, label, ok, detail) {
  steps.push({ label, ok, detail: detail || '' });
  return ok;
}

/**
 * Every field map that can actually be USED, not just the base one.
 *
 * The mapper resolves its config with the incoming form id
 * (`resolveFieldMapConfig(formId)`), and `BITRIX24_FIELD_MAP_BY_FORM_ID` /
 * `byFormId` can override the status and the custom rules per form. Checking
 * only the base map would report green while leads from an overridden form use
 * a status the portal does not have, or resolve none of their fields.
 */
function fieldMapVariants() {
  const base = loadBitrixFieldMapConfig();
  const variants = [{ label: 'base map', config: resolveFieldMapConfig('') }];
  for (const formId of Object.keys(base.byFormId || {})) {
    variants.push({ label: `form ${formId}`, config: resolveFieldMapConfig(formId) });
  }
  return variants;
}

/** Configuration that can be judged without calling Bitrix at all. */
async function checkConfiguration(steps) {
  const configured = await isBitrixConfigured();
  step(
    steps,
    'Bitrix24 enabled and webhook configured',
    configured,
    configured
      ? `Inbound webhook at ${await webhookHost()} (secret not shown).`
      : 'Turn Bitrix24 on and enter the inbound webhook URL in Settings → RingCentral → Bitrix24. Leads are still posted to Telegram and still texted from the shared number.',
  );
  if (!configured) return false;

  const mapper = await getBitrixMapperConfig();
  step(steps, 'Entity', true, `Creating a ${mapper.entity}.`);
  if (mapper.entity === 'deal') {
    const ok = Number(mapper.dealCategoryId) > 0 && Boolean(mapper.dealStageId);
    step(
      steps,
      'Deal pipeline',
      ok,
      ok
        ? `Category ${mapper.dealCategoryId}, stage ${mapper.dealStageId}.`
        : 'A deal category and a deal stage are both required when the entity is deal — set them in Settings → RingCentral → Bitrix24. Every lead is rejected until both are set.',
    );
  }

  // The one that has been quietly wrong: a NAME here is not a Bitrix user id.
  const raw = String(mapper.assignedById || '').trim();
  const numeric = Number(raw);
  if (!raw) {
    step(
      steps,
      'Assignee at creation',
      true,
      'Not set — new leads go to the inbound webhook\'s owner, then a Bitrix distribution rule may reassign them. That is the expected setup.',
    );
  } else if (Number.isFinite(numeric) && numeric > 0) {
    step(steps, 'Assignee at creation', true, `Every new lead is assigned to Bitrix user ${numeric}.`);
  } else {
    step(
      steps,
      'Assignee at creation',
      false,
      `The assignee at creation is "${raw}", which is not a numeric Bitrix user id, so it is IGNORED and leads go to the webhook owner. `
      + 'In Settings → RingCentral → Bitrix24 enter the id from the Bitrix profile URL (/company/personal/user/<id>/), or leave it blank if a distribution rule assigns leads.',
    );
  }
  return true;
}

/** Reachability plus the `crm` scope, proven by reading the lead schema. */
async function checkReachable(steps, { fetchImpl, entity = 'lead' }) {
  let catalog = null;
  try {
    catalog = await loadBitrixFieldCatalog(fetchImpl);
  } catch (err) {
    step(steps, 'Bitrix reachable (crm.lead.fields)', false, err.message);
    return null;
  }
  if (!catalog?.fields) {
    step(
      steps,
      'Bitrix reachable (crm.lead.fields)',
      false,
      'The lead schema could not be read. Check the webhook is still valid and has the crm scope — the same scope crm.lead.get needs to read back the assignee.',
    );
    return null;
  }
  step(
    steps,
    'Bitrix reachable (crm.lead.fields)',
    true,
    `${Object.keys(catalog.fields).length} lead fields, ${(catalog.statuses || []).length} statuses. The crm scope covers crm.lead.get too.`,
  );

  // A deal lands in a pipeline STAGE, not a lead status, so checking lead
  // statuses on a deal portal would report a value nothing uses.
  if (entity !== 'deal') checkStatuses(steps, catalog);
  return catalog;
}

/** The configured status must exist — for the base map AND every form override. */
function checkStatuses(steps, catalog) {
  const known = new Set((catalog.statuses || []).map((s) => String(s.STATUS_ID)));
  const checked = [];
  const bad = [];
  for (const { label, config } of fieldMapVariants()) {
    const wanted = String(config.statusId || '').trim();
    if (!wanted) continue;
    checked.push(`${label} → "${wanted}"`);
    if (!known.has(wanted)) bad.push(`${label} → "${wanted}"`);
  }
  if (!checked.length) return;

  step(
    steps,
    'Configured lead status exists',
    bad.length === 0,
    bad.length === 0
      ? `New leads land in: ${checked.join(', ')}.`
      : `This portal does not have ${bad.join(', ')} `
        + `(it has: ${[...known].join(', ') || 'none readable'}). Bitrix may reject those leads.`,
  );
}

/** Can the form's own questions be stored, or do they only reach COMMENTS? */
function resolveRuleField(rule, catalog) {
  if (typeof rule === 'string') return catalog?.fields?.[rule] ? rule : null;
  if (rule?.bitrixField) return catalog?.fields?.[rule.bitrixField] ? rule.bitrixField : null;
  if (rule?.matchTitle) return findFieldByTitleHints(catalog?.fields, rule.matchTitle)?.name || null;
  return null;
}

function checkFieldMap(steps, catalog) {
  const variants = fieldMapVariants();
  let mappedTotal = 0;
  const problems = [];

  for (const { label, config } of variants) {
    const custom = config.custom || {};
    const keys = Object.keys(custom);
    mappedTotal += keys.length;
    const unmatched = keys.filter((key) => !resolveRuleField(custom[key], catalog));
    if (unmatched.length) {
      problems.push(`${label}: ${keys.length - unmatched.length}/${keys.length} resolve, no field for ${unmatched.join(', ')}`);
    }
  }

  if (!mappedTotal) {
    step(steps, 'Form answers → Bitrix fields', true, 'No custom questions are mapped.');
    return;
  }

  // Not a failure of the LEAD — the answers do reach the CRM, in COMMENTS. It
  // is a "you asked for fields and the portal has none" notice.
  step(
    steps,
    'Form answers → Bitrix fields',
    problems.length === 0,
    problems.length === 0
      ? `Every mapped question resolves to a Bitrix field, across ${variants.length} map(s) (base + per-form overrides).`
      : `${problems.join('; ')}. `
        + 'Those answers are written into the lead COMMENTS instead, so nothing is lost — create the lead fields in Bitrix and re-run '
        + '`npm run discover-bitrix-fields` to store them properly. (The field catalog is cached for the life of the process, so a new field needs a restart.)',
  );
}

/**
 * The step the SMS sender actually depends on: read a real lead back and see
 * whether its owner maps to a recruiter who can send.
 */
async function checkAssigneeReadback(steps, { db, fetchImpl }) {
  let lead = null;
  try {
    const res = await db.query(
      `SELECT id, external_id, bitrix_id, bitrix_status, created_at
         FROM leads
        WHERE source = 'facebook' AND bitrix_id IS NOT NULL AND bitrix_status = 'created'
        ORDER BY created_at DESC
        LIMIT 1`
    );
    lead = res.rows[0] || null;
  } catch (err) {
    step(steps, 'Assignee readback', false, `Could not look up a recent lead: ${err.message}`);
    return;
  }

  if (!lead) {
    step(
      steps,
      'Assignee readback',
      true,
      'No Facebook lead has been created in Bitrix yet, so there is nothing to read back. This step becomes meaningful after the first lead.',
    );
    return;
  }

  const outcome = await getCrmRecordAssignee({ bitrixId: lead.bitrix_id, fetchImpl });
  // Follow the SAME path the sender takes: in a Simple-CRM portal the lead keeps
  // the webhook's owner and the recruiter lands on the deal it was converted
  // into. Reading only the lead here would report a failure the sender does not
  // actually have — a panel that cries wolf is worse than no panel.
  let via = 'crm.lead.get';
  if (outcome.ok) {
    const own = outcome.assignedById;
    const mapped = own == null ? null : await rc.getRecruiterByBitrixUserId(own).catch(() => null);
    if (!mapped) {
      const fromDeal = await getConvertedDealAssignee({ leadId: lead.bitrix_id, fetchImpl });
      if (fromDeal != null) {
        outcome.assignedById = fromDeal;
        via = 'converted deal';
      }
    }
  }
  if (!outcome.ok) {
    step(
      steps,
      'Assignee readback (crm.lead.get)',
      false,
      `Lead ${lead.bitrix_id}: ${outcome.error || outcome.reason}. Without this read the sender cannot tell who owns a lead, so every lead falls back to the shared number.`,
    );
    return;
  }
  if (outcome.assignedById == null) {
    step(
      steps,
      'Assignee readback (crm.lead.get)',
      false,
      `Lead ${lead.bitrix_id} has no responsible person. Leads must be assigned — by a Bitrix distribution rule, or by the "assignee at creation" in Settings → RingCentral → Bitrix24 — or the sender has nobody to match.`,
    );
    return;
  }

  let recruiter = null;
  try {
    recruiter = await rc.getRecruiterByBitrixUserId(outcome.assignedById);
  } catch (err) {
    step(steps, 'Assignee readback (crm.lead.get)', false, `Bitrix user ${outcome.assignedById}, but the recruiter lookup failed: ${err.message}`);
    return;
  }

  if (!recruiter) {
    step(
      steps,
      'Assignee readback (crm.lead.get)',
      false,
      `Lead ${lead.bitrix_id} belongs to Bitrix user ${outcome.assignedById} (via ${via}), who is not mapped to any recruiter. `
      + 'Use "Match recruiters to Bitrix users" above, or enter that id on their row in Settings → RingCentral — otherwise their leads keep going out from the shared number.',
    );
    return;
  }
  const canSend = rc.recruiterCanSendSms(recruiter);
  step(
    steps,
    'Assignee readback (crm.lead.get)',
    canSend,
    canSend
      ? `Lead ${lead.bitrix_id} → Bitrix user ${outcome.assignedById} (via ${via}) → ${recruiter.name} (${recruiter.phone_number}), who can send.`
      : `Lead ${lead.bitrix_id} → ${recruiter.name}, but they have no RingCentral credentials, so their leads use the shared number. Send them a sign-in link.`,
  );
}

/** How many recruiters are actually wired end to end. */
async function checkSenderCoverage(steps) {
  let recruiters = [];
  try {
    recruiters = await rc.listRecruiters({ includeInactive: false });
  } catch (err) {
    step(steps, 'Recruiters mapped to Bitrix users', false, `Could not list recruiters: ${err.message}`);
    return;
  }
  if (!recruiters.length) {
    step(steps, 'Recruiters mapped to Bitrix users', false, 'No active recruiters. Every lead uses the shared number.');
    return;
  }
  const mapped = recruiters.filter((r) => r.bitrix_user_id);
  const ready = mapped.filter((r) => rc.recruiterCanSendSms(r));
  const noBitrixId = recruiters.filter((r) => !r.bitrix_user_id).map((r) => r.name);
  const noCredentials = mapped.filter((r) => !rc.recruiterCanSendSms(r)).map((r) => r.name);

  // EVERY active recruiter, not merely one. An active recruiter can be assigned
  // a lead, so one who cannot text it is a real gap — and reporting "aligned"
  // while some of them silently fall back to the shared number is exactly the
  // blindness this diagnostic exists to remove. A recruiter who should not
  // receive leads belongs deactivated, and is already excluded above.
  const gaps = [];
  if (noBitrixId.length) gaps.push(`no Bitrix user id: ${noBitrixId.join(', ')}`);
  if (noCredentials.length) gaps.push(`no RingCentral credentials: ${noCredentials.join(', ')}`);
  step(
    steps,
    'Recruiters mapped to Bitrix users',
    ready.length === recruiters.length,
    `${ready.length} of ${recruiters.length} active recruiter(s) can text their own leads`
    + (gaps.length ? ` — ${gaps.join('; ')}. Their leads use the shared number.` : '.'),
  );
}

/** What has actually happened to the last leads — the outcome, not the config. */
async function checkRecentOutcomes(steps, { db, days = 14 }) {
  try {
    const res = await db.query(
      `SELECT COALESCE(bitrix_status, 'unrecorded') AS status, count(*)::int AS n
         FROM leads
        WHERE source = 'facebook' AND created_at > NOW() - ($1 || ' days')::interval
        GROUP BY 1
        ORDER BY 2 DESC`,
      [String(days)]
    );
    const rows = res.rows || [];
    if (!rows.length) {
      step(steps, `Facebook leads in the last ${days} days`, true, 'None — nothing to judge.');
      return;
    }
    const summary = rows.map((r) => `${r.status}: ${r.n}`).join(', ');
    const failed = rows.find((r) => r.status === 'failed');
    step(
      steps,
      `Facebook leads in the last ${days} days`,
      !failed,
      failed
        ? `${summary}. ${failed.n} failed to reach Bitrix — check the logs for [Bitrix24].`
        : summary,
    );
  } catch (err) {
    step(steps, `Facebook leads in the last ${days} days`, false, err.message);
  }
}

/**
 * Run the whole chain.
 *
 * @param {object} [deps]
 * @param {object} [deps.db]        database/db (injectable for tests)
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {number} [deps.days]      window for the outcome summary
 * @returns {Promise<{ok: boolean, steps: Array<{label:string, ok:boolean, detail:string}>}>}
 */
async function diagnoseBitrix({ db = require('../database/db'), fetchImpl = fetch, days = 14 } = {}) {
  const steps = [];
  if (!(await checkConfiguration(steps))) return { ok: false, steps };

  const { entity } = await getBitrixMapperConfig();
  const catalog = await checkReachable(steps, { fetchImpl, entity });
  if (catalog) checkFieldMap(steps, catalog);

  await checkSenderCoverage(steps);
  if (catalog) await checkAssigneeReadback(steps, { db, fetchImpl });
  await checkRecentOutcomes(steps, { db, days });

  return { ok: steps.every((s) => s.ok), steps };
}

module.exports = { diagnoseBitrix, webhookHost };
