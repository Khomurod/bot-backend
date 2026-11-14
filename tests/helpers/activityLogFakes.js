'use strict';

/**
 * The fakes behind Monitoring → Logs' end-to-end tests: only the database
 * modules, the Telegram side and `fetch` are fake — the Bitrix client, its
 * recorder, the streak check and every call site are the production code.
 * Load this BEFORE requiring anything under services/. Names are made up.
 *
 * `fake.fail[method]` makes the fake Bitrix answer that method with
 * `'refuse'` (HTTP 400, Bitrix said no) or `'timeout'` (no answer).
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = {
    id: filename, filename, loaded: true, exports,
  };
}

const fake = {
  logged: [], notices: [], said: [], deals: {}, fail: {}, boardStatusStillTrue: true, settings: null,
};

const DEFAULT_SETTINGS = {
  enabled: false, schemaSource: 'catalog_exact',
  schemaMapping: { dealFields: { truck: 'UF_T', driverType: 'UF_D' }, truckEntityTypeId: 1040 },
};

const good = (e) => e.result === 'done' || e.result === 'already_done';
/** The streak's view of one feature, as database/activityLog.js reads it. */
const answered = (trigger) => fake.logged.filter((e) => e.trigger === trigger && !e.safetyCheck);

stub('database/bitrix.js', { getBitrixConfig: async () => ({ enabled: true, webhookUrl: 'https://acme.bitrix24.com/rest/1/s3cret/' }) });
stub('database/activityLog.js', {
  PAGE_SIZE: 50,
  insertEntry: async (e) => { fake.logged.push({ id: fake.logged.length + 1, ...e }); return { id: fake.logged.length }; },
  recentForTrigger: async (trigger, limit) => answered(trigger).reverse().slice(0, limit).map(({ id, result }) => ({ id, result })),
  streakStartId: async (trigger) => {
    const list = answered(trigger);
    let i = list.length;
    while (i > 0 && !good(list[i - 1])) i -= 1;
    return list[i] ? list[i].id : null;
  },
  entryWords: async (id) => fake.logged.find((e) => e.id === id) || null,
});
stub('services/notifications/send.js', {
  notify: async (n) => {
    const key = `${n.category}:${n.subjectType}:${n.subjectId}:${n.discriminator}`;
    if (fake.notices.some((x) => x.key === key)) return { recorded: false, reason: 'duplicate' };
    fake.notices.push({ ...n, key });
    return { recorded: true };
  },
});
stub('database/operationalNotifications.js', {
  findNoticeByTelegramMessage: async () => ({ subjectId: '5', subjectType: 'board_bitrix_question' }),
  noticeAboutSubject: async ({ noticeKey }) => ({
    keyExists: fake.notices.some((x) => x.key === noticeKey),
    // The quiet hours are the outbox's to answer; these tests run inside them
    // only when they say so.
    sentWithin: fake.quiet === true && fake.notices.length > 0,
  }),
});
stub('database/controlOperators.js', { isControlOperator: async () => false });
stub('database/backgroundRuns.js', { recordRunStart: async () => {}, recordRunFinish: async () => {} });
stub('database/boardBitrixAdvice.js', {
  getResponderIds: async () => ['777'],
  getAdvice: async () => ({
    actions: [{
      type: 'set_stage', label: 'Move to HOME',
      params: { dealId: 321, stageId: 'C9:H', stageName: 'HOME', fromStageId: 'C9:W' },
    }],
  }),
});
stub('database/boardBitrix.js', {
  getSettings: async () => fake.settings || DEFAULT_SETTINGS,
  getDiscrepancy: async () => ({ id: 5, state: 'asked', askCount: 1, kind: 'status_differs' }),
  claimStageSync: async () => 7,
  stageSyncAttempt: async () => 2,
  finishStageSync: async () => {},
  confirmBoardStatus: async () => fake.boardStatusStillTrue,
  isLiveSyncEnabled: async () => true,
});
stub('services/boardBitrix/ask.js', {
  SUBJECT_TYPE: 'board_bitrix_question',
  askNext: async () => ({}),
  sayUnder: async (args) => { fake.said.push(args); },
  linksFor: () => ({}),
});
const proposal = {
  id: 11, chatId: '-100', rootMessageId: 900, kind: 'move', dealId: 321, dealTitle: 'Ann Lee',
  fromStageId: 'C5:NEW', fromStageName: 'New', toStageId: 'C5:SAFETY', toStageName: 'Sent to Safety',
};
stub('database/hiringStages/proposals.js', {
  getProposal: async () => ({ ...proposal, status: 'pending' }),
  transition: async (id, from, to) => ({ ...proposal, status: to }),
});
stub('database/hiringStages/crmRecords.js', {
  claim: async ({ chatId, rootMessageId }) => ({
    record: {
      id: 31, chatId, rootMessageId, status: 'claimed', displayName: 'Ann Lee',
    },
  }),
  advance: async () => ({ id: 31 }),
  getForRoot: async () => null,
});
stub('services/hiringStages/groupMessages.js', {
  sendProposal: async () => {}, sendNotice: async () => {}, refreshProposal: async () => {}, closeProposal: async () => {},
});

function answer(method, params) {
  const { deals } = fake;
  if (method === 'crm.deal.get') return deals[params.id];
  if (method === 'crm.deal.update') {
    deals[params.id] = { ...deals[params.id], ...params.fields };
    return true;
  }
  if (method === 'crm.deal.list') return Object.values(deals).filter((d) => String(d.CATEGORY_ID) === '33');
  if (method === 'crm.duplicate.findbycomm') return { CONTACT: [] };
  if (method === 'crm.contact.list') return [];
  if (method === 'crm.contact.add') return 55;
  if (method === 'crm.deal.add') {
    deals[99] = {
      ID: '99', TITLE: params.fields.TITLE, STAGE_ID: params.fields.STAGE_ID, CATEGORY_ID: '5', CLOSED: 'N',
    };
    return 99;
  }
  if (method === 'crm.lead.add') return 77;
  return undefined;
}

/** A fake Bitrix behind the real client's default `fetch`. */
global.fetch = async (url, init) => {
  const method = String(url).replace(/^.*\/rest\/1\/s3cret\//, '').replace(/\.json$/, '');
  const params = JSON.parse(init?.body || '{}');
  if (fake.fail[method] === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  if (fake.fail[method] === 'refuse') {
    return new Response(JSON.stringify({ error: 'ACCESS_DENIED', error_description: 'Access denied' }), { status: 400 });
  }
  const result = answer(method, params);
  if (result === undefined && !['crm.deal.get'].includes(method)) {
    return new Response(JSON.stringify({ error: 'ERROR_METHOD_NOT_FOUND' }), { status: 400 });
  }
  return new Response(JSON.stringify({ result }), { status: 200 });
};

function reset() {
  Object.assign(fake, {
    logged: [], notices: [], said: [], fail: {}, boardStatusStillTrue: true, settings: null, quiet: false,
    deals: {
      321: {
        ID: '321', TITLE: 'ALAN BROWN', STAGE_ID: 'C9:W', CATEGORY_ID: '9', CLOSED: 'N',
      },
    },
  });
}

/** Every streak check the recorder started has finished. */
const settled = () => require('../../services/activityLog/record').__settledForTests(); // eslint-disable-line global-require

const NOW = Date.parse('2026-11-14T12:00:00Z');
const discrepancy = () => ({
  kind: 'status_differs', key: 'status_differs:deal:321',
  board: {
    rowKey: 'owner_operator:001:alan-brown', status: 'HOME', statusChangedAt: new Date(NOW - 60 * 60000),
    name: 'ALAN BROWN', fleetType: 'owner_operator', truck: '001',
  },
  deal: {
    id: 321, title: 'ALAN BROWN', stageId: 'C9:W', fleetType: 'owner_operator', truckNumber: '001',
  },
  expectedStageId: 'C9:H',
});
const schema = {
  categoryId: 9, stageByRole: { HOME: 'C9:H', VACATION: 'C9:V', SHOP: 'C9:S', WORKING: 'C9:W' }, fingerprint: 'abc', writeSafe: true,
};

/** One live status-sync pass through the REAL default dependencies. */
function syncWithRealDeps() {
  const stageSync = require('../../services/boardBitrix/stageSync'); // eslint-disable-line global-require
  const deps = { ...stageSync.defaultDeps(), now: () => NOW };
  return stageSync.runStageSync({
    discrepancies: [discrepancy()], schema, mode: 'live', deps,
  });
}

module.exports = {
  fake, proposal, reset, settled, syncWithRealDeps, NOW,
};
