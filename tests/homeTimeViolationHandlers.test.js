'use strict';

/**
 * bot/handlers/homeTimeViolationHandlers.js — only accounting may answer an
 * alert, the first answer stands, and "not charging" asks the presser why.
 * The store is faked in require.cache; its write-once rule is proved on
 * PostgreSQL in tests/homeTimeViolationsPg.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const STORE = path.resolve(__dirname, '../database/homeTime/violationNotices.js');
const state = { rows: [], reasons: [], prompts: [] };
require.cache[STORE] = {
  id: STORE, filename: STORE, loaded: true,
  exports: {
    async getViolationSettings() { return { violation_alerts_chat_id: '-1009' }; },
    async decide({ decision, byId, byName }) {
      const open = state.rows.filter((r) => r.decision == null);
      if (!open.length) return { rows: state.rows, alreadyDecided: true };
      for (const r of open) Object.assign(r, { decision, decided_by_id: String(byId), decided_by_name: byName, decided_at: new Date('2026-10-21T15:00:00Z') });
      return { rows: open, alreadyDecided: false };
    },
    async setReasonPrompt(p) { state.prompts.push(p); },
    async recordReason({ promptMessageId, byId, reason }) {
      const hit = state.rows.filter((r) => r.decision === 'not_charging' && r.decided_by_id === String(byId)
        && !r.decision_reason && state.prompts.some((p) => p.promptMessageId === promptMessageId));
      for (const r of hit) r.decision_reason = reason;
      return hit;
    },
  },
};

const { __test: h } = require('../bot/handlers/homeTimeViolationHandlers');

const CAMERON = { id: 6504395610, username: 'cameron_acc' };
const ELLA = { id: 8245947790, username: 'Ellaaccounting' };
const DISPATCHER = { id: 111, username: 'cameron_acc_fake' };

function reset() {
  state.rows = [{
    id: 1, deal_id: '7', home_from: '2026-10-03', violation: 'early', driver_name: 'Driver 7',
    road_days: 17, home_days: 2, telegram_message_id: 901, decision: null,
  }];
  state.prompts = [];
  h.resetCache();
}

function press(from, kind) {
  const calls = { answers: [], edits: [], sent: [] };
  const ctx = {
    match: [`htv:${kind}:1`, kind, '1'],
    from,
    callbackQuery: { message: { message_id: 901, chat: { id: -1009 } } },
    async answerCbQuery(text, extra) { calls.answers.push({ text, extra }); },
    async editMessageText(text) { calls.edits.push(text); },
    telegram: { async sendMessage(chatId, text, extra) { calls.sent.push({ chatId, text, extra }); return { message_id: 950 }; } },
  };
  return { ctx, calls };
}

test('ONLY ACCOUNTING: anyone else is told so, and nothing is written', async () => {
  reset();
  const { ctx, calls } = press(DISPATCHER, 'c');
  await h.onButton(ctx);
  assert.match(calls.answers[0].text, /Only accounting/);
  assert.equal(calls.answers[0].extra.show_alert, true);
  assert.equal(state.rows[0].decision, null);
  assert.equal(calls.edits.length, 0);
});

test('Charged: recorded, and the alert says who — buttons gone; a second accountant cannot change it', async () => {
  reset();
  const first = press(CAMERON, 'c');
  await h.onButton(first.ctx);
  assert.equal(state.rows[0].decision, 'charged');
  assert.match(first.calls.edits[0], /✅ <b>Charged<\/b> by @cameron_acc on Oct 21/);
  assert.match(first.calls.answers[0].text, /Marked as charged/);

  const second = press(ELLA, 'n');
  await h.onButton(second.ctx);
  assert.equal(state.rows[0].decision, 'charged', 'the first answer stands');
  assert.match(second.calls.answers[0].text, /Already marked charged by @cameron_acc/);
  assert.equal(second.calls.edits.length, 0);
});

test('Not charging: recorded at once, the presser is asked why, and their reply is written in', async () => {
  reset();
  const { ctx, calls } = press(ELLA, 'n');
  await h.onButton(ctx);
  assert.equal(state.rows[0].decision, 'not_charging');
  assert.match(calls.edits[0], /Reason: waiting for @Ellaaccounting to reply/);
  assert.equal(calls.sent[0].extra.reply_to_message_id, 901);
  assert.deepEqual(calls.sent[0].extra.reply_markup, { force_reply: true, selective: true });
  assert.deepEqual(state.prompts, [{ chatId: -1009, messageId: 901, promptMessageId: 950 }]);

  // Somebody else's reply to the prompt is not the reason.
  const edits = [];
  const replyCtx = (from, text) => ({
    chat: { id: -1009 }, from,
    message: { text, reply_to_message: { message_id: 950 } },
    telegram: { async editMessageText(chatId, msgId, _i, body) { edits.push({ chatId, msgId, body }); } },
  });
  let passed = 0;
  await h.onReply(replyCtx(CAMERON, 'I think we should'), async () => { passed += 1; });
  assert.equal(passed, 1, 'not consumed');
  assert.equal(state.rows[0].decision_reason, undefined);

  await h.onReply(replyCtx(ELLA, 'family emergency, approved by Tom'), async () => { passed += 1; });
  assert.equal(passed, 1, 'consumed');
  assert.equal(state.rows[0].decision_reason, 'family emergency, approved by Tom');
  assert.equal(edits[0].msgId, 901);
  assert.match(edits[0].body, /Reason: family emergency, approved by Tom/);
});

test('an ordinary message anywhere passes straight through', async () => {
  reset();
  let passed = 0;
  await h.onReply({ chat: { id: -555 }, message: { text: 'hello' } }, async () => { passed += 1; });
  await h.onReply({ chat: { id: -555 }, from: ELLA, message: { text: 'x', reply_to_message: { message_id: 950 } } }, async () => { passed += 1; });
  assert.equal(passed, 2);
});
