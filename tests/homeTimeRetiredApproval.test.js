/**
 * The Approve / Do Not Approve buttons are gone — and the ones already sitting
 * in the staff group are retired politely rather than left to spin.
 *
 * Deleting the handler would have been the easy change and the wrong one:
 * Telegram keeps delivering presses from old cards, and a press with no handler
 * shows a spinner and then nothing, which reads as a broken bot. Worse, the old
 * handler would have gone on writing 'approved' onto requests in a system that
 * no longer has approval.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const HANDLER_PATH = path.resolve(__dirname, '../bot/homeTimeRequestHandlers.js');
const HT_PATH = path.resolve(__dirname, '../database/homeTime.js');
const SERVICE_PATH = path.resolve(__dirname, '../services/homeTimeRequestService.js');
const CARDS_PATH = path.resolve(__dirname, '../services/homeTimeRequestCards.js');

function loadHandler({ request = { id: 7, driver_name: 'A ONE', unit_number: '9', home_from: '2026-09-18', home_to: '2026-09-21' } } = {}) {
  for (const p of [HANDLER_PATH, HT_PATH, SERVICE_PATH]) delete require.cache[p];
  const state = { answers: [], edits: [], decisions: [] };
  require.cache[HT_PATH] = {
    exports: { async getHomeTimeRequestById(id) { return request ? { ...request, id } : null; } },
  };
  require.cache[SERVICE_PATH] = {
    exports: {
      CALLBACK_PREFIX: 'htreq',
      applyHomeTimeDecision: async (...args) => { state.decisions.push(args); return { ok: true }; },
    },
  };
  const handlers = [];
  const bot = { action: (re, fn) => handlers.push({ re, fn }) };
  require(HANDLER_PATH).registerHomeTimeRequestHandlers(bot);
  const ctx = (match) => ({
    match,
    callbackQuery: { message: { chat: { id: -100777 }, message_id: 55 } },
    telegram: {
      async editMessageText(chatId, messageId, _inline, text, extra) {
        state.edits.push({ chatId, messageId, text, extra });
      },
    },
    async answerCbQuery(text, extra) { state.answers.push({ text, extra }); },
  });
  return { handlers, ctx, state };
}

test('pressing an old Approve button explains that approval is not needed', async () => {
  const { handlers, ctx, state } = loadHandler();
  await handlers[0].fn(ctx(['htreq:approve:7', 'approve', '7']));
  assert.equal(state.answers.length, 1);
  assert.match(state.answers[0].text, /no longer needs approval/i);
  assert.equal(state.answers[0].extra.show_alert, true, 'said out loud, not as a toast');
});

test('and it never records a decision — there is no decision to record', async () => {
  const { handlers, ctx, state } = loadHandler();
  await handlers[0].fn(ctx(['htreq:deny:7', 'deny', '7']));
  assert.equal(state.decisions.length, 0);
});

test('the card is rewritten so its buttons are gone for everyone', async () => {
  const { handlers, ctx, state } = loadHandler();
  await handlers[0].fn(ctx(['htreq:approve:7', 'approve', '7']));
  assert.equal(state.edits.length, 1);
  assert.equal(state.edits[0].chatId, -100777);
  assert.equal(state.edits[0].messageId, 55);
  assert.equal(state.edits[0].extra.reply_markup, undefined, 'no keyboard survives the edit');
  assert.match(state.edits[0].text, /no longer needs approval/i);
  assert.match(state.edits[0].text, /A ONE \(Unit 9\)/);
});

test('a request that no longer exists still gets an answer and a cleaned card', async () => {
  const { handlers, ctx, state } = loadHandler({ request: null });
  await handlers[0].fn(ctx(['htreq:approve:7', 'approve', '7']));
  assert.equal(state.answers.length, 1);
  assert.equal(state.edits.length, 1);
});

test('anyone may press it — the handler grants nothing, so it gates nothing', async () => {
  // The old handler refused non-approvers. With no decision behind the button,
  // refusing a colleague would only be a confusing dead end.
  const src = require('node:fs').readFileSync(HANDLER_PATH, 'utf8');
  assert.equal(/isHomeTimeApprover|isHomeTimeManager/.test(src), false);
  assert.equal(/applyHomeTimeDecision/.test(src), false);
});

test('no card builder produces an inline keyboard any more', () => {
  const cards = require(CARDS_PATH);
  assert.equal(typeof cards.buildDecisionButtons, 'undefined');
  const src = require('node:fs').readFileSync(CARDS_PATH, 'utf8');
  // Comments still explain why editing a card without a keyboard clears it, so
  // look for the telegraf builder itself rather than the words.
  assert.equal(/require\('telegraf'\)|Markup\.|inlineKeyboard\(/.test(src), false);
  for (const build of ['buildCardText', 'buildDecidedCardText', 'buildRetiredCardText', 'buildExpiredCardText']) {
    assert.equal(typeof cards[build](
      { driver_name: 'A', home_from: '2026-09-18', home_to: '2026-09-21' }, 'approved', 'x'
    ), 'string', `${build} returns text only`);
  }
});
