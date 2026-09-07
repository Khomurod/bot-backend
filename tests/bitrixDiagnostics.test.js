/**
 * "Is Bitrix aligned?" — the diagnosis, and what each answer must say.
 *
 * The reason this exists at all: Bitrix's ASSIGNEE now decides which
 * recruiter's number texts a driver, so a portal that never assigns a lead
 * looks exactly like a portal that works — every lead just quietly goes out
 * from the shared number. Each check below therefore has to fail for a
 * *specific* reason and say what to do about it, or it is no better than the
 * silence it replaces.
 *
 * Also asserted, and non-negotiable: the diagnosis never returns the webhook
 * URL. The Bitrix inbound webhook's path IS its credential.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const CONFIG_PATH = require.resolve('../config/config');
const RC_PATH = require.resolve('../database/ringcentral');
const BITRIX_PATH = require.resolve('../services/bitrix24Service');
const CATALOG_PATH = require.resolve('../services/bitrix24FieldCatalog');
const MAP_LOADER_PATH = require.resolve('../services/bitrix24FieldMapLoader');
const DIAG_PATH = require.resolve('../services/bitrix24DiagnosticsService');

const WEBHOOK = 'https://wenze.bitrix24.com/rest/1/super-secret-value/';

const CATALOG = {
  fields: { NAME: {}, LAST_NAME: {}, PHONE: {}, EMAIL: {}, COMMENTS: {} },
  statuses: [{ STATUS_ID: 'NEW', NAME: 'Unassigned' }, { STATUS_ID: 'IN_PROCESS', NAME: 'In Progress' }],
};

const JANE = {
  id: 7, name: 'Jane Doe', phone_number: '+15550001111', active: true,
  bitrix_user_id: 17, refresh_token_encrypted: 'enc',
};

function loadDiag({
  enabled = true,
  webhookUrl = WEBHOOK,
  entity = 'lead',
  assignedById = '',
  dealCategoryId = '',
  dealStageId = '',
  assigneeWaitMs = 25000,
  catalog = CATALOG,
  catalogError = null,
  mapCustom = {},
  mapStatusId = 'NEW',
  byFormId = {},
  recruiters = [JANE],
  recruiterByBitrix = { 17: JANE },
  assignee = { ok: true, assignedById: 17 },
  leadRow = { id: 1, external_id: 'lg-1', bitrix_id: '4242', bitrix_status: 'created' },
  outcomeRows = [{ status: 'created', n: 12 }],
  dbError = null,
} = {}) {
  const realConfig = require('../config/config');
  require.cache[CONFIG_PATH] = {
    exports: {
      ...realConfig,
      bitrix24Enabled: enabled,
      bitrix24WebhookUrl: webhookUrl,
      bitrix24AssigneeWaitMs: assigneeWaitMs,
    },
  };
  require.cache[BITRIX_PATH] = {
    exports: {
      isBitrixConfigured: async () => Boolean(enabled && webhookUrl),
      normalizeWebhookBase: (u) => (u ? String(u) : ''),
      getWebhookBase: async () => (enabled && webhookUrl ? String(webhookUrl) : ''),
      getBitrixMapperConfig: async () => ({ entity, assignedById, dealCategoryId, dealStageId, sourceId: 'WEB' }),
      loadBitrixFieldCatalog: async () => {
        if (catalogError) throw catalogError;
        return catalog;
      },
      getCrmRecordAssignee: async () => assignee,
    },
  };
  // Mirrors the real loader: a form id merges its override over the base map.
  require.cache[MAP_LOADER_PATH] = {
    exports: {
      loadBitrixFieldMapConfig: () => ({ custom: mapCustom, statusId: mapStatusId, byFormId, defaults: {} }),
      resolveFieldMapConfig: (formId) => {
        const override = byFormId[String(formId || '').trim()] || null;
        return {
          custom: { ...mapCustom, ...(override?.custom || {}) },
          statusId: String(override?.statusId || mapStatusId || '').trim(),
          defaults: {},
        };
      },
    },
  };
  require.cache[CATALOG_PATH] = {
    exports: {
      findFieldByTitleHints: (fields, hints) => {
        // Stands in for the real title matcher: only "phone" resolves here.
        const wants = (hints || []).map((h) => String(h).toLowerCase());
        return wants.includes('phone') ? { name: 'PHONE', meta: {} } : null;
      },
      resolveEnumerationValue: (_m, v) => v,
      findIncomingStatusId: () => 'NEW',
    },
  };
  require.cache[RC_PATH] = {
    exports: {
      listRecruiters: async () => recruiters,
      getRecruiterByBitrixUserId: async (id) => recruiterByBitrix[id] || null,
      recruiterCanSendSms: (row) => Boolean(row?.phone_number)
        && Boolean(row?.refresh_token_encrypted || row?.jwt_token_encrypted),
    },
  };
  const db = {
    query: async (sql) => {
      if (dbError) throw dbError;
      if (/FROM leads\s+WHERE source = 'facebook' AND bitrix_id/i.test(sql)) {
        return { rows: leadRow ? [leadRow] : [] };
      }
      if (/GROUP BY 1/i.test(sql)) return { rows: outcomeRows };
      throw new Error(`Unexpected query: ${sql.slice(0, 60)}`);
    },
  };

  delete require.cache[DIAG_PATH];
  const diag = require(DIAG_PATH);
  const restore = () => {
    for (const path of [CONFIG_PATH, BITRIX_PATH, MAP_LOADER_PATH, CATALOG_PATH, RC_PATH, DIAG_PATH]) {
      delete require.cache[path];
    }
  };
  return { diag, db, restore };
}

const run = async (opts) => {
  const { diag, db, restore } = loadDiag(opts);
  try {
    const result = await diag.diagnoseBitrix({ db, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
    return { ...result, byLabel: (needle) => result.steps.find((s) => s.label.toLowerCase().includes(needle.toLowerCase())) };
  } finally { restore(); }
};

test('a healthy portal reports ok end to end', async () => {
  const result = await run();
  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 1));
  assert.match(result.byLabel('reachable').detail, /5 lead fields/);
  assert.match(result.byLabel('lead status').detail, /base map → "NEW"/);
  assert.match(result.byLabel('Assignee readback').detail, /Jane Doe/);
  assert.match(result.byLabel('Assignee readback').detail, /can send/);
});

test('the webhook secret never appears anywhere in the output', async () => {
  const result = await run();
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('super-secret-value'), 'the webhook path is the credential');
  assert.ok(serialized.includes('wenze.bitrix24.com'), 'the host is safe and useful');
});

test('an unconfigured Bitrix stops after saying so, and says leads still get texted', async () => {
  const result = await run({ enabled: false, webhookUrl: '' });
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 1, 'no point checking anything else');
  // It has to say WHERE to configure it — the panel, not an env var on the host.
  assert.match(result.steps[0].detail, /Settings → RingCentral → Bitrix24/);
  assert.match(result.steps[0].detail, /shared number/i, 'the operator needs to know leads are not lost');
});

test('a NAME in BITRIX24_ASSIGNED_BY_ID is reported as ignored — the quiet misconfiguration', async () => {
  const result = await run({ assignedById: 'Tom Robinson' });
  const step = result.byLabel('Assignee at creation');
  assert.equal(step.ok, false);
  assert.match(step.detail, /"Tom Robinson"/);
  assert.match(step.detail, /IGNORED/);
  assert.match(step.detail, /company\/personal\/user/, 'and where to find the real id');
});

test('a numeric assignee, or none at all, are both fine', async () => {
  const numeric = await run({ assignedById: '17' });
  assert.equal(numeric.byLabel('Assignee at creation').ok, true);
  assert.match(numeric.byLabel('Assignee at creation').detail, /Bitrix user 17/);

  const blank = await run({ assignedById: '' });
  assert.equal(blank.byLabel('Assignee at creation').ok, true);
  assert.match(blank.byLabel('Assignee at creation').detail, /distribution rule/);
});

test('an unreachable portal fails the reachability step with the real reason', async () => {
  const result = await run({ catalogError: new Error('HTTP 401: Invalid webhook') });
  const step = result.byLabel('reachable');
  assert.equal(step.ok, false);
  assert.match(step.detail, /Invalid webhook/);
  assert.equal(result.ok, false);
});

test('a status id the portal does not have is flagged with the ones it does', async () => {
  const result = await run({ mapStatusId: 'INCOMING' });
  const step = result.byLabel('lead status');
  assert.equal(step.ok, false);
  assert.match(step.detail, /INCOMING/);
  assert.match(step.detail, /NEW, IN_PROCESS/, 'name what the portal actually has');
});

test('a question with no Bitrix field says the answer lands in COMMENTS instead', async () => {
  const result = await run({
    mapCustom: {
      do_you_have_2_years_of_experience: { matchTitle: ['years', 'experience'] },
      are_you_cdl_a_over_the_road_driver: { matchTitle: ['cdl'] },
      phone_ish: { matchTitle: ['phone'] },
    },
  });
  const step = result.byLabel('Form answers');
  assert.equal(step.ok, false);
  assert.match(step.detail, /base map: 1\/3 resolve/);
  assert.match(step.detail, /do_you_have_2_years_of_experience/);
  assert.match(step.detail, /COMMENTS/, 'nothing is lost — say so');
  assert.match(step.detail, /restart/, 'and warn that the catalog is cached');
});

test('a fully mapped set of questions passes', async () => {
  const result = await run({ mapCustom: { phone_ish: { matchTitle: ['phone'] } } });
  assert.equal(result.byLabel('Form answers').ok, true);
});

test('an assignee nobody mapped is the finding that explains a shared-number fallback', async () => {
  const result = await run({ assignee: { ok: true, assignedById: 99 }, recruiterByBitrix: {} });
  const step = result.byLabel('Assignee readback');
  assert.equal(step.ok, false);
  assert.match(step.detail, /Bitrix user 99/);
  assert.match(step.detail, /not mapped to any recruiter/);
  assert.match(step.detail, /Settings → RingCentral/);
});

test('an assignee who is mapped but cannot send is a different, named problem', async () => {
  const bare = { ...JANE, refresh_token_encrypted: null, jwt_token_encrypted: null };
  const result = await run({ recruiters: [bare], recruiterByBitrix: { 17: bare } });
  const step = result.byLabel('Assignee readback');
  assert.equal(step.ok, false);
  assert.match(step.detail, /no RingCentral credentials/);
  assert.match(step.detail, /sign-in link/);
});

test('an unassigned lead in the portal is reported as such', async () => {
  const result = await run({ assignee: { ok: true, assignedById: null } });
  const step = result.byLabel('Assignee readback');
  assert.equal(step.ok, false);
  assert.match(step.detail, /no responsible person/);
});

test('a failed readback names the consequence, not just the error', async () => {
  const result = await run({ assignee: { ok: false, reason: 'api_error', error: 'ACCESS_DENIED' } });
  const step = result.byLabel('Assignee readback');
  assert.equal(step.ok, false);
  assert.match(step.detail, /ACCESS_DENIED/);
  assert.match(step.detail, /falls back to the shared number/);
});

test('no lead created yet is honest rather than alarming', async () => {
  const result = await run({ leadRow: null });
  const step = result.byLabel('Assignee readback');
  assert.equal(step.ok, true);
  assert.match(step.detail, /nothing to read back/);
});

/**
 * PARTIAL COVERAGE IS NOT ALIGNMENT. An active recruiter can be assigned a
 * lead, so one who cannot text it is a real gap — and a card reading "Bitrix
 * is aligned" while some recruiters silently fall back to the shared number is
 * the exact blindness this diagnostic exists to remove. A recruiter who should
 * not receive leads belongs deactivated, and is excluded already.
 */
test('coverage fails while ANY active recruiter cannot text their own leads', async () => {
  const bob = { id: 8, name: 'Bob', phone_number: '+15550002222', active: true, bitrix_user_id: null, jwt_token_encrypted: 'enc' };
  const ada = { id: 9, name: 'Ada', phone_number: '+15550003333', active: true, bitrix_user_id: 18 };
  const result = await run({ recruiters: [JANE, bob, ada] });
  const step = result.byLabel('Recruiters mapped');
  assert.equal(step.ok, false, 'one ready recruiter out of three is not "aligned"');
  assert.match(step.detail, /1 of 3 active recruiter\(s\) can text their own leads/);
  assert.match(step.detail, /no Bitrix user id: Bob/);
  assert.match(step.detail, /no RingCentral credentials: Ada/);
  assert.match(step.detail, /shared number/);
  assert.equal(result.ok, false, 'and the whole diagnosis cannot read as aligned');
});

test('coverage passes only when every active recruiter is ready', async () => {
  const ada = {
    id: 9, name: 'Ada', phone_number: '+15550003333', active: true,
    bitrix_user_id: 18, refresh_token_encrypted: 'enc',
  };
  const result = await run({ recruiters: [JANE, ada] });
  const step = result.byLabel('Recruiters mapped');
  assert.equal(step.ok, true);
  assert.match(step.detail, /2 of 2 active recruiter\(s\)/);
  assert.doesNotMatch(step.detail, /shared number/, 'nothing to warn about');
});

/**
 * PER-FORM OVERRIDES ARE PART OF THE EFFECTIVE CONFIG. The mapper resolves its
 * map with the incoming form id, and byFormId / BITRIX24_FIELD_MAP_BY_FORM_ID
 * can change both the status and the custom rules. Checking only the base map
 * would report green while one form's leads use a status the portal lacks, or
 * resolve none of their fields.
 */
test('a form override with a bad status is caught, not hidden behind the base map', async () => {
  const result = await run({
    mapStatusId: 'NEW',
    byFormId: { '1489274899611047': { statusId: 'INCOMING' } },
  });
  const step = result.byLabel('lead status');
  assert.equal(step.ok, false);
  assert.match(step.detail, /form 1489274899611047 → "INCOMING"/);
  assert.doesNotMatch(step.detail, /base map → "NEW"/, 'only the broken one is named');
});

test('a form override whose questions resolve nowhere is caught too', async () => {
  const result = await run({
    mapCustom: { phone_ish: { matchTitle: ['phone'] } },
    byFormId: { '1489274899611047': { custom: { cdl: { matchTitle: ['cdl'] } } } },
  });
  const step = result.byLabel('Form answers');
  assert.equal(step.ok, false);
  assert.match(step.detail, /form 1489274899611047: 1\/2 resolve, no field for cdl/);
  assert.match(step.detail, /COMMENTS/);
});

test('form overrides that are all fine report how many maps were checked', async () => {
  const result = await run({
    mapCustom: { phone_ish: { matchTitle: ['phone'] } },
    byFormId: { '1489274899611047': { custom: { other_phone: { matchTitle: ['phone'] } } } },
  });
  const step = result.byLabel('Form answers');
  assert.equal(step.ok, true);
  assert.match(step.detail, /across 2 map\(s\)/);
  assert.match(step.detail, /per-form overrides/);

  const statusStep = result.byLabel('lead status');
  assert.equal(statusStep.ok, true);
  assert.match(statusStep.detail, /base map → "NEW"/);
  assert.match(statusStep.detail, /form 1489274899611047 → "NEW"/, 'the inherited status is checked too');
});

test('no recruiters at all is a failure, because every lead uses the shared number', async () => {
  const result = await run({ recruiters: [] });
  const step = result.byLabel('Recruiters mapped');
  assert.equal(step.ok, false);
  assert.match(step.detail, /shared number/);
});

test('a single mapped question still reports across the base map only', async () => {
  const result = await run({ mapCustom: { phone_ish: { matchTitle: ['phone'] } } });
  const step = result.byLabel('Form answers');
  assert.equal(step.ok, true);
  assert.match(step.detail, /across 1 map\(s\)/);
});

test('recent outcomes summarize what actually happened, and failures fail the step', async () => {
  const healthy = await run({ outcomeRows: [{ status: 'created', n: 12 }, { status: 'disabled', n: 1 }] });
  const okStep = healthy.byLabel('last 14 days');
  assert.equal(okStep.ok, true);
  assert.match(okStep.detail, /created: 12/);

  const broken = await run({ outcomeRows: [{ status: 'created', n: 3 }, { status: 'failed', n: 4 }] });
  const badStep = broken.byLabel('last 14 days');
  assert.equal(badStep.ok, false);
  assert.match(badStep.detail, /4 failed to reach Bitrix/);
  assert.match(badStep.detail, /\[Bitrix24\]/, 'point at the log tag');
});

test('a database that cannot be read is reported, not thrown', async () => {
  const result = await run({ dbError: new Error('connect ECONNREFUSED') });
  assert.equal(result.ok, false);
  assert.match(result.byLabel('Assignee readback').detail, /ECONNREFUSED/);
  assert.match(result.byLabel('last 14 days').detail, /ECONNREFUSED/);
});

test('a deal entity with no pipeline is caught before a single lead is rejected', async () => {
  const broken = await run({ entity: 'deal' });
  const step = broken.byLabel('Deal pipeline');
  assert.equal(step.ok, false);
  assert.match(step.detail, /every lead is rejected/i);

  const fine = await run({ entity: 'deal', dealCategoryId: '3', dealStageId: 'C3:NEW' });
  assert.equal(fine.byLabel('Deal pipeline').ok, true);
});
