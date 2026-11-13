'use strict';

/**
 * A stateful fake Bitrix (contacts, deals, stages) and in-memory stores for
 * the hiring-stage reviewer — so the REAL reviewer, deal finder, creation
 * (services/hiringStages/crmCreate.js) and messages run end to end. A call can
 * be made to fail: refused (Bitrix said no), or timed out before or AFTER
 * Bitrix did the work — the case a retry must never repeat.
 *
 * Load this before requiring anything under services/hiringStages/.
 */

const path = require('node:path');
const { createCardStore } = require('./hiringStageCardStore');

const ROOT = path.resolve(__dirname, '..', '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CHAT = '-1001234567890';
const SAFETY = '900';
const SETTINGS = {
  enabled: true, stageProposalsEnabled: true, chatId: CHAT, topicId: 3, bitrixTopicId: 77, safetyUserIds: [SAFETY],
};

const state = {
  messages: [], finished: [], retried: [], proposals: [], records: [], notices: [], sent: [], edits: [], deleted: [],
  contacts: [], deals: [], calls: [], fail: {}, nextId: 500, aiAnswer: null, renames: [],
};

// ── stores ──────────────────────────────────────────────────────────────────
stub('database/hiringStages/threads.js', {
  listThreadMessages: async () => state.messages,
  finishThread: async (t, o) => { state.finished.push(o); return true; },
  retryThread: async (t, o) => { state.retried.push(o); return true; },
});
const OPEN = new Set(['pending', 'applying']);
stub('database/hiringStages/proposals.js', {
  listForRoot: async (chatId, root) => state.proposals.filter((r) => r.rootMessageId === root).slice().reverse(),
  reserveProposal: async (p) => {
    if (state.proposals.some((r) => r.rootMessageId === p.rootMessageId && OPEN.has(r.status))) return null;
    const row = { ...p, id: state.proposals.length + 1, status: 'pending', botMessageId: null };
    state.proposals.push(row);
    return { ...row };
  },
  recordSent: async (id, mid) => { state.proposals.find((r) => r.id === id).botMessageId = mid; },
  transition: async (id, from, to) => {
    const row = state.proposals.find((r) => r.id === id);
    if (!row || ![].concat(from).includes(row.status)) return null;
    row.status = to;
    return { ...row };
  },
});
const IN_FLIGHT = new Set(['claimed', 'creating_contact', 'creating_deal']);
stub('database/hiringStages/crmRecords.js', {
  getForRoot: async (chatId, root) => {
    const row = state.records.find((r) => r.chatId === chatId && r.rootMessageId === root);
    return row ? { ...row } : null;
  },
  claim: async ({
    chatId, rootMessageId, phone, driverName, displayName = null,
  }) => {
    const own = state.records.find((r) => r.chatId === chatId && r.rootMessageId === rootMessageId);
    const clash = (p) => state.records.some((r) => r !== own && r.phone === p && IN_FLIGHT.has(r.status));
    if (own) {
      const next = ['blocked', 'failed'].includes(own.status) ? 'claimed' : own.status;
      if (IN_FLIGHT.has(next) && clash(own.phone)) return { busy: true };
      const fresh = ['blocked', 'failed'].includes(own.status);
      Object.assign(own, {
        status: next, attempts: own.attempts + 1, displayName: fresh ? displayName : (own.displayName ?? displayName),
      });
      return { record: { ...own } };
    }
    if (clash(phone)) return { busy: true };
    const row = {
      id: state.records.length + 1, chatId, rootMessageId, phone, driverName, displayName, status: 'claimed',
      contactId: null, contactReused: false, dealId: null, dealReused: false, attempts: 1,
    };
    state.records.push(row);
    return { record: { ...row } };
  },
  advance: async (id, from, to, fields = {}) => {
    const row = state.records.find((r) => r.id === id);
    if (!row || ![].concat(from).includes(row.status)) return null;
    const { error, ...rest } = fields;
    Object.assign(row, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null)),
      { status: to, lastError: error ?? null });
    return { ...row };
  },
});
const OPEN_RENAME = new Set(['pending', 'applying']);
stub('database/hiringStages/renames.js', {
  getRename: async (id) => { const r = state.renames.find((x) => x.id === Number(id)); return r ? { ...r } : null; },
  reserveRename: async (r) => {
    const same = state.renames.find((x) => x.rootMessageId === r.rootMessageId && x.dealId === r.dealId);
    if (same && same.status !== 'unsent') return null;
    if (!same && state.renames.some((x) => x.rootMessageId === r.rootMessageId && OPEN_RENAME.has(x.status))) return null;
    const row = same || {
      id: state.renames.length + 1, chatId: String(r.chatId), contactRenamed: false, titleWritten: false, botMessageId: null,
    };
    Object.assign(row, { ...r, chatId: String(r.chatId), status: 'pending' });
    if (!same) state.renames.push(row);
    return { ...row };
  },
  recordSent: async (id, mid) => { state.renames.find((x) => x.id === id).botMessageId = mid; },
  markTitleWritten: async (id) => {
    const row = state.renames.find((x) => x.id === id);
    if (row && row.status === 'applying') row.titleWritten = true;
  },
  transition: async (id, from, to, extra = {}) => {
    const row = state.renames.find((x) => x.id === id);
    if (!row || ![].concat(from).includes(row.status)) return null;
    Object.assign(row, {
      status: to,
      decidedByName: extra.userName ?? row.decidedByName ?? null,
      contactRenamed: extra.contactRenamed ?? row.contactRenamed,
      lastError: extra.error ?? null,
    });
    return { ...row };
  },
});
const cardStore = createCardStore();
stub('database/hiringStages/cards.js', cardStore.store);
stub('database/hiringStages/notices.js', {
  reserve: async (chatId, root, key) => {
    if (state.notices.some((n) => n.root === root && n.key === key)) return null;
    state.notices.push({ root, key });
    return state.notices.length;
  },
  recordSent: async () => {},
  release: async () => {},
});
stub('database/safetyApprovals/settings.js', { getSafetyApprovalSettings: async () => SETTINGS });
stub('database/bitrix.js', {
  getBitrixConfig: async () => ({ enabled: true, webhookUrl: 'https://acme.bitrix24.com/rest/1/s/', dealCategoryId: '', assignedById: '' }),
});

// ── the fake Bitrix ─────────────────────────────────────────────────────────
class BitrixError extends Error {
  constructor(message, { retryable = false } = {}) { super(message); this.name = 'BitrixError'; this.retryable = retryable; }
}
const STAGE_ROWS = [
  { STATUS_ID: 'NEW', NAME: 'New Lead', SORT: 10 },
  { STATUS_ID: 'PREPARATION', NAME: 'Contacting', SORT: 20 },
  { STATUS_ID: 'UC_SAFETY', NAME: 'Sent to Safety', SORT: 30 },
  { STATUS_ID: 'UC_DRUG', NAME: 'Ready to Drug Test', SORT: 35 },
  { STATUS_ID: 'WON', NAME: 'Hired', SORT: 40, EXTRA: { SEMANTICS: 'S' } },
  { STATUS_ID: 'LOSE', NAME: 'Lost', SORT: 50, EXTRA: { SEMANTICS: 'F' } },
];
const ORIGINATOR = 'wenze_recruiting';

/** `state.fail[method] = 'refuse' | 'timeout' | 'timeout_after'`, used once. */
function maybeFail(method, { before }) {
  const how = state.fail[method];
  if (!how) return;
  if (how === 'timeout_after' && before) return;
  if (how !== 'timeout_after' && !before) return;
  delete state.fail[method];
  if (how === 'refuse') throw new BitrixError(`Bitrix ${method}: Access denied`);
  throw new BitrixError(`Bitrix did not answer ${method} in 15000ms`, { retryable: true });
}
const record = (method) => state.calls.push(method);
/** As services/bitrix24DealStages.js `mapDeal` reads it: an empty TITLE comes back null. */
const asRead = (d) => ({ ...d, title: d.title || null });
const openDeals = (pred) => state.deals.filter((d) => !d.closed && pred(d)).map(asRead);

stub('services/bitrix24DealStages.js', {
  BitrixError,
  ORIGINATOR,
  MAX_ROWS: 10,
  findContactIdsByPhone: async (phones) => {
    record('crm.duplicate.findbycomm');
    return state.contacts.filter((c) => c.phones.some((p) => phones.includes(p))).map((c) => c.id);
  },
  listContactsByLastName: async (word) => {
    record('crm.contact.list');
    return state.contacts.filter((c) => c.last.toLowerCase().includes(word)).map((c) => ({ ...c, name: `${c.first} ${c.last}` }));
  },
  listOpenDealsForContact: async (id) => { record('crm.deal.list'); return openDeals((d) => d.contactId === id); },
  listOpenDealsByTitle: async (word) => {
    record('crm.deal.list');
    return openDeals((d) => String(d.title).toLowerCase().includes(word));
  },
  getDeal: async (id) => {
    record('crm.deal.get');
    maybeFail('crm.deal.get', { before: true });
    const d = state.deals.find((x) => x.id === Number(id));
    return d ? asRead(d) : null; // a deleted deal: null, as the real client reads Bitrix's "Not found"
  },
  getContact: async (id) => {
    record('crm.contact.get');
    maybeFail('crm.contact.get', { before: true });
    const c = state.contacts.find((x) => x.id === Number(id));
    return c ? { ...c, name: `${c.first} ${c.last}` } : null;
  },
  findByOrigin: async (entity, origin) => {
    record(`crm.${entity}.list`);
    return (entity === 'contact' ? state.contacts : state.deals).filter((r) => r.originId === origin).map((r) => r.id);
  },
  createContact: async (f) => {
    record('crm.contact.add');
    maybeFail('crm.contact.add', { before: true });
    const id = (state.nextId += 1);
    state.contacts.push({ id, first: f.first, last: f.last, phones: [f.phone], originId: f.originId });
    maybeFail('crm.contact.add', { before: false });
    return id;
  },
  createDeal: async (f) => {
    record('crm.deal.add');
    maybeFail('crm.deal.add', { before: true });
    const id = (state.nextId += 1);
    state.deals.push({
      id, title: f.title, stageId: f.stageId, categoryId: String(f.categoryId), contactId: f.contactId,
      closed: false, originId: f.originId, modifiedAt: '2026-11-10T10:00:00Z',
    });
    maybeFail('crm.deal.add', { before: false });
    return id;
  },
  renameDeal: async (id, title) => {
    record('crm.deal.update');
    maybeFail('crm.deal.update', { before: true });
    state.deals.find((d) => d.id === Number(id)).title = title;
    return true;
  },
  renameContact: async (id, { first, last }) => {
    record('crm.contact.update');
    maybeFail('crm.contact.update', { before: true });
    Object.assign(state.contacts.find((c) => c.id === Number(id)), { first, last });
    return true;
  },
  listStageRows: async () => STAGE_ROWS,
  moveDealToStage: async () => { throw new Error('nothing may be moved without a press'); },
  dealUrl: async (id) => `https://acme.bitrix24.com/crm/deal/details/${id}/`,
});

// ── Telegram and the conversation ───────────────────────────────────────────
const telegram = {
  sendMessage: async (chatId, text, extra) => { state.sent.push({ chatId, text, extra }); return { message_id: 9000 + state.sent.length }; },
  editMessageText: async (chatId, messageId, _i, text, extra) => { state.edits.push({ messageId, text, extra }); return true; },
  deleteMessage: async (chatId, messageId) => { state.deleted.push(messageId); return true; },
};
const m = (messageId, over = {}) => ({
  messageId, fromUserId: '500', fromName: 'Kim R', text: null, photos: [], documents: [],
  mediaGroupId: null, replyToMessageId: null, ...over,
});
const conversation = (postText, root = 169) => [
  m(root, { photos: [{ file_id: 'cdl' }], text: postText }),
  m(root + 3, { fromUserId: SAFETY, fromName: 'Safety', text: 'CLH sent', replyToMessageId: root }),
];
const thread = (over = {}) => ({ id: 1, chatId: CHAT, rootMessageId: 169, lastMessageId: 172, attempts: 1, revision: 1, ...over });

function reset() {
  cardStore.reset();
  Object.assign(state, {
    messages: [], finished: [], retried: [], proposals: [], records: [], notices: [], sent: [], edits: [], deleted: [],
    contacts: [], deals: [], calls: [], fail: {}, nextId: 500, renames: [],
    aiAnswer: { move: true, stage_id: 'UC_SAFETY', driver_name: null, evidence: 'CLH sent' },
  });
}

const { processThread } = require('../../services/hiringStages/reviewer');
const { handleStageButton } = require('../../services/hiringStages/actions');

const readStage = async () => ({ parsed: state.aiAnswer, model: 'fake' });
const run = (t = thread()) => processThread(t, { settings: SETTINGS, telegram, readStage });
const ANN = { id: 4242, first_name: 'Ann', is_bot: false };
const press = (action, id, from = ANN, chatId = CHAT) => handleStageButton({
  action, proposalId: id, chatId, from,
}, { telegram });

module.exports = {
  cardStore,
  CHAT, SAFETY, SETTINGS, ORIGINATOR, BitrixError, state, telegram, m, conversation, thread, reset, run, press,
};
