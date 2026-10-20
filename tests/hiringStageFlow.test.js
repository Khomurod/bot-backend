'use strict';

/**
 * The Bitrix stage proposals end to end, with the stores in memory, a fake
 * Bitrix and a fake Telegram: a conversation read → a proposal posted → a
 * button pressed → the deal moved. Pinned: nothing moves without a press, a
 * deal changed by hand meanwhile is not moved, a press is answered once, the
 * same stage is never proposed twice, and the recruiter is asked once to
 * create a missing deal. Names and numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CHAT = '-1001234567890';
const SAFETY = '900';
const SETTINGS = { enabled: true, stageProposalsEnabled: true, chatId: CHAT, topicId: 3, safetyUserIds: [SAFETY] };

// ── the stores, in memory ───────────────────────────────────────────────────
let threadMessages = [];
let finished = [];
let retried = [];
let rows = [];
stub('database/hiringStages/threads.js', {
  listThreadMessages: async () => threadMessages,
  finishThread: async (t, o) => { finished.push(o); return true; },
  retryThread: async (t, o) => { retried.push(o); return true; },
});
const OPEN = new Set(['pending', 'applying']);
stub('database/hiringStages/proposals.js', {
  listForRoot: async (chatId, root) => rows.filter((r) => r.rootMessageId === root).slice().reverse(),
  getProposal: async (id) => rows.find((r) => r.id === Number(id)) || null,
  reserveProposal: async (p) => {
    if (rows.some((r) => r.rootMessageId === p.rootMessageId && OPEN.has(r.status))) return null;
    const row = { ...p, id: rows.length + 1, status: 'pending', botMessageId: null };
    rows.push(row);
    return { ...row };
  },
  recordSent: async (id, mid) => { rows.find((r) => r.id === id).botMessageId = mid; },
  transition: async (id, from, to, extra = {}) => {
    const row = rows.find((r) => r.id === id);
    if (!row || ![].concat(from).includes(row.status)) return null;
    Object.assign(row, { status: to, decidedByName: extra.userName ?? row.decidedByName, lastError: extra.error ?? null });
    return { ...row };
  },
  attachDeal: async (id, deal) => {
    const row = rows.find((r) => r.id === id && r.status === 'applying');
    if (!row) return null;
    Object.assign(row, deal, { kind: 'move', status: 'pending' });
    return { ...row };
  },
});
stub('database/safetyApprovals/settings.js', { getSafetyApprovalSettings: async () => SETTINGS });
stub('database/bitrix.js', { getBitrixConfig: async () => ({ enabled: true, webhookUrl: 'https://acme.bitrix24.com/rest/1/s/', dealCategoryId: '' }) });

// ── a fake Bitrix ───────────────────────────────────────────────────────────
class BitrixError extends Error {
  constructor(message, { retryable = false } = {}) { super(message); this.retryable = retryable; }
}
const STAGE_ROWS = [
  { STATUS_ID: 'NEW', NAME: 'New', SORT: 10 },
  { STATUS_ID: 'PREPARATION', NAME: 'CLEARINGHOUSE CHECK', SORT: 20 },
  { STATUS_ID: 'EXECUTING', NAME: 'MVR + PSP CHECK', SORT: 30 },
  { STATUS_ID: 'FINAL_INVOICE', NAME: 'READY', SORT: 40 },
];
let bitrixDeal = null;
let found = { status: 'none' };
let moves = [];
let failMove = false;
stub('services/bitrix24DealStages.js', {
  BitrixError,
  listStageRows: async () => STAGE_ROWS,
  getDeal: async () => (bitrixDeal ? { ...bitrixDeal } : null),
  moveDealToStage: async (id, stageId) => {
    if (failMove) throw new BitrixError('Bitrix unreachable', { retryable: true });
    moves.push({ id, stageId });
    bitrixDeal.stageId = stageId;
    return true;
  },
  dealUrl: async (id) => `https://acme.bitrix24.com/crm/deal/details/${id}/`,
});
stub('services/hiringStages/dealFinder.js', { findCandidateDeal: async () => found });

const { processThread } = require('../services/hiringStages/reviewer');
const { handleStageButton } = require('../services/hiringStages/actions');
const { AiUnavailableError } = require('../services/ai/router');

// ── a fake Telegram ─────────────────────────────────────────────────────────
let sent = [];
let edits = [];
const send = async (chatId, text, extra) => { sent.push({ chatId, text, extra }); return { message_id: 9000 + sent.length }; };
const telegram = {
  sendMessage: send,
  editMessageText: async (chatId, mid, _i, text, extra) => { edits.push({ mid, text, extra }); return true; },
};

const m = (messageId, over = {}) => ({
  messageId, fromUserId: '500', fromName: 'Kim R', text: null, photos: [], documents: [],
  mediaGroupId: null, replyToMessageId: null, ...over,
});
const POST = m(169, { photos: [{ file_id: 'cdl' }], text: 'Company Driver - 80 CPM\nPHILLIPS SAMUEL\n(404) 555-0134' });
const CLH = m(172, { fromUserId: SAFETY, fromName: 'Safety', text: 'CLH sent', replyToMessageId: 169 });
const CLEAN = m(174, { fromUserId: SAFETY, fromName: 'Safety', text: 'CLEAN', replyToMessageId: 172 });
const thread = (over = {}) => ({ id: 1, chatId: CHAT, rootMessageId: 169, lastMessageId: 174, attempts: 1, revision: 1, ...over });
const ANN = { id: 4242, first_name: 'Ann', is_bot: false };

let aiAnswer = null;
const readStage = async () => {
  if (aiAnswer instanceof Error) throw aiAnswer;
  return { parsed: aiAnswer, model: 'fake' };
};
const run = (t = thread()) => processThread(t, { settings: SETTINGS, telegram, readStage });
const press = (action, id, chatId = CHAT, from = ANN) => handleStageButton({ action, proposalId: id, chatId, from }, { telegram });

function reset() {
  threadMessages = [POST, CLH, CLEAN]; finished = []; retried = []; rows = []; sent = []; edits = []; moves = [];
  failMove = false;
  telegram.sendMessage = send;
  bitrixDeal = { id: 12, title: 'Facebook Lead – Samuel Phillips', stageId: 'PREPARATION', categoryId: '0', contactId: 55 };
  found = { status: 'found', deal: { ...bitrixDeal }, via: 'phone' };
  aiAnswer = { move: true, stage_id: 'EXECUTING', driver_name: 'Samuel Phillips', evidence: 'CLEAN' };
}

test('a conversation that moved on posts ONE proposal, replying in General, and moves nothing', async () => {
  reset();
  assert.equal(await run(), 'done');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, CHAT);
  assert.equal(sent[0].extra.reply_to_message_id, 174, 'it answers the message that moved the conversation');
  assert.equal(sent[0].extra.message_thread_id, undefined, 'General has no thread id');
  assert.match(sent[0].text, /move <b>Samuel Phillips<\/b> to <b>MVR \+ PSP CHECK<\/b>\?/);
  assert.match(sent[0].text, /Now: CLEARINGHOUSE CHECK/);
  assert.deepEqual(moves, [], 'A MODEL NEVER MOVES A DEAL');
  assert.equal(rows[0].botMessageId, 9001);
  assert.equal(finished[0].outcome.result, 'proposed');

  // The same conversation read again proposes nothing new.
  assert.equal(await run(), 'done');
  assert.equal(sent.length, 1);
  assert.equal(finished[1].outcome.result, 'already_proposed');
});

test('ANYONE IN THE GROUP may confirm — once — and the deal moves', async () => {
  reset();
  await run();
  const out = await press('ok', 1);
  assert.match(out.text, /moved to MVR \+ PSP CHECK/);
  assert.deepEqual(moves, [{ id: 12, stageId: 'EXECUTING' }]);
  assert.equal(rows[0].status, 'applied');
  assert.match(edits.at(-1).text, /moved to <b>MVR \+ PSP CHECK<\/b> in Bitrix — Ann/);
  assert.equal(edits.at(-1).extra.reply_markup, undefined, 'the buttons go for everybody');

  assert.equal((await press('ok', 1, CHAT, { id: 5, first_name: 'Bo' })).text, 'Already answered.');
  assert.equal(moves.length, 1);
});

test('a press from another chat, or by a bot, changes nothing', async () => {
  reset();
  await run();
  assert.match((await press('ok', 1, '-100999')).text, /no longer works here/);
  assert.match((await press('ok', 1, CHAT, { id: 1, is_bot: true })).text, /Only a person/);
  assert.equal(rows[0].status, 'pending');
  assert.deepEqual(moves, []);
});

test('A DEAL MOVED BY HAND MEANWHILE IS NOT MOVED AGAIN', async () => {
  reset();
  await run();
  bitrixDeal.stageId = 'FINAL_INVOICE';
  const out = await press('ok', 1);
  assert.equal(out.alert, true);
  assert.match(out.text, /now at READY/);
  assert.deepEqual(moves, []);
  assert.equal(rows[0].status, 'stale');
});

test('Bitrix failing gives the claim back — the button still works afterwards', async () => {
  reset();
  await run();
  failMove = true;
  assert.match((await press('ok', 1)).text, /Bitrix did not answer/);
  assert.equal(rows[0].status, 'pending');
  failMove = false;
  await press('ok', 1);
  assert.equal(rows[0].status, 'applied');
});

test('"No" closes it, and that stage is never proposed again for the conversation', async () => {
  reset();
  await run();
  await press('no', 1);
  assert.equal(rows[0].status, 'declined');
  assert.match(edits.at(-1).text, /not moved to <b>MVR \+ PSP CHECK<\/b> — Ann/);
  await run();
  assert.equal(sent.length, 1);
});

test('a LATER stage supersedes the open proposal', async () => {
  reset();
  await run();
  threadMessages = [...threadMessages, m(180, { fromUserId: SAFETY, text: 'Approved', replyToMessageId: 169 })];
  aiAnswer = { move: true, stage_id: 'FINAL_INVOICE', driver_name: 'Samuel Phillips', evidence: 'Approved' };
  await run(thread({ lastMessageId: 180, revision: 2 }));
  assert.equal(rows[0].status, 'superseded');
  assert.match(edits.at(-1).text, /replaced by a newer proposal/);
  assert.equal(rows[1].status, 'pending');
  assert.equal(sent[1].extra.reply_to_message_id, 180);
});

test('NO DEAL: the recruiter who posted is asked ONCE; "search again" turns it into a proposal', async () => {
  reset();
  found = { status: 'none' };
  await run();
  assert.equal(rows[0].kind, 'create_deal');
  assert.equal(sent[0].extra.reply_to_message_id, 169, 'asked under the recruiter\'s own post');
  assert.match(sent[0].text, /no open deal found for <b>Samuel Phillips<\/b>/);
  assert.match(sent[0].text, /tg:\/\/user\?id=500/);
  await run();
  assert.equal(sent.length, 1, 'asked once');

  assert.match((await press('re', 1)).text, /Still no open deal/);
  assert.equal(rows[0].status, 'pending');

  found = { status: 'found', deal: { ...bitrixDeal }, via: 'name' };
  assert.match((await press('re', 1)).text, /Found the deal/);
  assert.equal(rows[0].kind, 'move');
  assert.equal(rows[0].dealId, 12);
  assert.deepEqual(edits.at(-1).extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['hst:ok:1', 'hst:no:1']);
  await press('ok', 1);
  assert.deepEqual(moves, [{ id: 12, stageId: 'EXECUTING' }]);
});

test('not a candidate post, a lone post, or an unverified answer posts nothing', async () => {
  reset();
  threadMessages = [m(181, { text: 'unit 1407: can we find his signed agreement' }), m(182, { text: 'not here yet', replyToMessageId: 181 })];
  await run(thread({ rootMessageId: 181 }));
  assert.equal(finished.at(-1).outcome.result, 'not_a_candidate_post');

  reset();
  aiAnswer = { move: true, stage_id: 'FINAL_INVOICE', driver_name: 'Samuel Phillips', evidence: 'Safety approved him' };
  await run();
  assert.equal(finished.at(-1).outcome.result, 'evidence_not_in_conversation');
  assert.equal(sent.length, 0);

  reset();
  found = { status: 'ambiguous', count: 2 };
  bitrixDeal = null;
  await run();
  assert.equal(finished.at(-1).outcome.result, 'ambiguous');
  assert.equal(sent.length, 0);
});

test('AI unavailable or Telegram refusing → try again later, with nothing left open', async () => {
  reset();
  aiAnswer = new AiUnavailableError('no provider');
  assert.equal(await run(), 'retry');
  assert.equal(retried.at(-1).delaySeconds, 60);
  assert.equal(await run(thread({ attempts: 6 })), 'gave_up');

  reset();
  telegram.sendMessage = async () => { throw new Error('chat not found'); };
  assert.equal(await run(), 'retry');
  assert.equal(rows[0].status, 'unsent', 'the reservation is given back');
});

test('a post with the driver\'s phone but no picture is still a candidate', async () => {
  reset();
  threadMessages = [m(169, { text: 'Company driver 80 CPM\nJordan Shackelford\n(404) 555-0199' }), CLH, CLEAN];
  aiAnswer = { move: true, stage_id: 'EXECUTING', driver_name: 'Jordan Shackelford', evidence: 'CLEAN' };
  await run();
  assert.equal(finished.at(-1).outcome.result, 'proposed');
});

test('a re-read never swaps an open proposal for an EARLIER stage', async () => {
  reset();
  aiAnswer = { move: true, stage_id: 'FINAL_INVOICE', driver_name: 'Samuel Phillips', evidence: 'CLEAN' };
  await run();
  aiAnswer = { move: true, stage_id: 'EXECUTING', driver_name: 'Samuel Phillips', evidence: 'CLEAN' };
  await run();
  assert.equal(finished.at(-1).outcome.result, 'already_proposed_further');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
});
