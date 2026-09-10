/**
 * The chat-id reachability check, and the pure parsing it stands on.
 *
 * The case that matters is `sign_flipped`: production stored '5052301861' for a
 * chat whose real id is -5052301861, every home-time internal alert failed with
 * "chat not found", and the only signal was a `failed` row nobody read. These
 * tests pin the rule that catches it and, just as importantly, the rules that
 * stop the check from refusing a save it cannot actually prove wrong.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChatId, isGroupShapedChatId, signFlipCandidate } = require('../lib/telegram/chatId');
const { checkChatId, checkChatIdColumns } = require('../services/telegramChatIdCheck');

// A groups table holding only the real staff chat.
const HR = { telegram_group_id: -5052301861, group_name: 'HR Personnel' };
function groupsWith(rows) {
  return async (id) => rows.find((r) => String(r.telegram_group_id) === String(id));
}
const knownGroups = groupsWith([HR]);
const noGroups = groupsWith([]);

test('normalizeChatId accepts a chat id and rejects everything else', () => {
  assert.equal(normalizeChatId('-1002997837889'), '-1002997837889');
  assert.equal(normalizeChatId('  -5052301861 '), '-5052301861');
  assert.equal(normalizeChatId(-5052301861), '-5052301861');
  for (const bad of ['', null, undefined, 'abc', '+5', '1.5', '12a', '0', '-0', '1'.repeat(21)]) {
    assert.equal(normalizeChatId(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('isGroupShapedChatId distinguishes a group id from a user id', () => {
  assert.equal(isGroupShapedChatId('-5052301861'), true);
  assert.equal(isGroupShapedChatId('5052301861'), false);
  assert.equal(isGroupShapedChatId('nonsense'), false);
});

test('signFlipCandidate flips in both directions and only for real ids', () => {
  assert.equal(signFlipCandidate('5052301861'), '-5052301861');
  assert.equal(signFlipCandidate('-5052301861'), '5052301861');
  assert.equal(signFlipCandidate('nope'), null);
});

test('a chat id we hold a row for is STILL probed when a client is available', async () => {
  // A `groups` row outlives the bot's access: deactivateGroup only flips
  // `active`, and bot_member_status='left' on an active group is common enough
  // that Stage 2 has a check for it. Historical presence is not reachability.
  let probed = false;
  const telegram = {
    async getChat() { probed = true; return { type: 'supergroup', title: 'HR Personnel' }; },
  };
  const r = await checkChatId('-5052301861', { getGroupByTelegramId: knownGroups, telegram });

  assert.equal(r.ok, true);
  assert.equal(r.status, 'known_group');
  assert.equal(probed, true, 'a stale row must not be trusted as current access');
});

test('a chat we have a row for but can no longer reach is REJECTED', async () => {
  // The exact regression: the bot was removed, the row remains, and without a
  // probe an admin could save it and recreate the silent-failure this prevents.
  const telegram = {
    async getChat() { throw new Error('403: Forbidden: bot was kicked from the supergroup chat'); },
  };
  const r = await checkChatId('-5052301861', { getGroupByTelegramId: knownGroups, telegram });

  assert.equal(r.ok, false);
  assert.equal(r.status, 'unreachable');
  assert.match(r.message, /kicked/);
});

test('with no Telegram client, a known row is still the best answer available', async () => {
  const r = await checkChatId('-5052301861', { getGroupByTelegramId: knownGroups });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'known_group');
  assert.equal(r.groupName, 'HR Personnel');
});

test('the production bug: a dropped minus sign is rejected and the real chat named', async () => {
  const r = await checkChatId('5052301861', { getGroupByTelegramId: knownGroups });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'sign_flipped');
  assert.equal(r.suggestion, '-5052301861');
  assert.match(r.message, /HR Personnel/);
  assert.match(r.message, /Did you mean -5052301861\?/);
});

test('the sign check runs BEFORE the live probe, so a resolvable user chat cannot mask it', async () => {
  // A positive id is a USER id, and getChat resolves one into a private chat.
  // Probing first would call that a success and save the typo.
  const telegram = { async getChat() { return { type: 'private', title: 'Some Person' }; } };
  const r = await checkChatId('5052301861', { getGroupByTelegramId: knownGroups, telegram });
  assert.equal(r.status, 'sign_flipped');
});

test('an unknown id the bot can reach is accepted', async () => {
  const telegram = { async getChat() { return { type: 'supergroup', title: 'New Staff Room' }; } };
  const r = await checkChatId('-1009999999999', { getGroupByTelegramId: noGroups, telegram });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'reachable');
  assert.equal(r.groupName, 'New Staff Room');
});

test('an unknown id the bot cannot reach is rejected, with the token stripped', async () => {
  const telegram = {
    async getChat() {
      const err = new Error('404: Not Found for bot123456:AAHsuperSECRETtoken_value');
      throw err;
    },
  };
  const r = await checkChatId('-1009999999999', { getGroupByTelegramId: noGroups, telegram });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'unreachable');
  assert.ok(!/AAHsuperSECRETtoken_value/.test(r.message), 'the bot token must never reach the response');
  assert.match(r.message, /bot\*\*\*/);
});

test('a private chat is rejected: these settings address a group', async () => {
  const telegram = { async getChat() { return { type: 'private', title: 'Someone' }; } };
  const r = await checkChatId('-1009999999999', { getGroupByTelegramId: noGroups, telegram });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'wrong_type');
});

test('with no Telegram client and nothing to contradict it, an id is accepted as unverified', async () => {
  // Refusing here would block a legitimate save for a chat we simply have not
  // captured — an outage of its own, caused by a check that cannot prove itself.
  const r = await checkChatId('-1009999999999', { getGroupByTelegramId: noGroups });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'unverified');
});

test('the dropped-minus rule still fires with no Telegram client at all', async () => {
  const r = await checkChatId('5052301861', { getGroupByTelegramId: knownGroups });
  assert.equal(r.status, 'sign_flipped');
});

test('a value that is not a chat id at all is rejected before any lookup', async () => {
  let looked = false;
  const r = await checkChatId('HR Personnel', {
    getGroupByTelegramId: async () => { looked = true; return undefined; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'invalid');
  assert.equal(looked, false);
});

test('a lookup failure degrades to the next rule instead of throwing', async () => {
  const boom = async () => { throw new Error('database unreachable'); };
  const r = await checkChatId('-1009999999999', { getGroupByTelegramId: boom });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'unverified');
});

test('checkChatIdColumns names the offending column and skips absent or cleared ones', async () => {
  const deps = { getGroupByTelegramId: knownGroups };

  const bad = await checkChatIdColumns(
    { internal_clarification_group_id: '5052301861' },
    ['completed_notify_group_id', 'internal_clarification_group_id'],
    deps
  );
  assert.equal(bad.column, 'internal_clarification_group_id');
  assert.match(bad.error, /^internal_clarification_group_id /);
  assert.equal(bad.result.suggestion, '-5052301861');

  // Clearing a destination must never have to satisfy a reachability check, and
  // a column absent from the patch is not being changed at all.
  for (const patch of [{ completed_notify_group_id: null }, { completed_notify_group_id: '' }, {}]) {
    const ok = await checkChatIdColumns(patch, ['completed_notify_group_id'], deps);
    assert.equal(ok.error, null, `expected ${JSON.stringify(patch)} to pass`);
  }
});

// ─── a private user as a destination ─────────────────────────────────────────

test('with allowPrivate, a reachable private chat is accepted and named as such', async () => {
  // AI monitoring alerts may go to one person rather than a room, and a user
  // the bot can message is a valid destination. Opt-in per caller: the
  // home-time settings still address a group, and their check is unchanged.
  const telegram = { async getChat() { return { type: 'private', first_name: 'Tom', username: 'tom' }; } };
  const r = await checkChatId('987654321', { getGroupByTelegramId: noGroups, telegram, allowPrivate: true });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'reachable_private');
  assert.match(r.groupName, /Tom/);
});

test('allowPrivate does not weaken the sign-flip check', async () => {
  // A positive id whose negation is a known GROUP is still a dropped minus sign,
  // even when a private destination would otherwise be welcome.
  const telegram = { async getChat() { return { type: 'private', first_name: 'Someone' }; } };
  const r = await checkChatId('5052301861', { getGroupByTelegramId: knownGroups, telegram, allowPrivate: true });
  assert.equal(r.status, 'sign_flipped');
});

test('without allowPrivate a private chat is still refused', async () => {
  const telegram = { async getChat() { return { type: 'private', first_name: 'Someone' }; } };
  const r = await checkChatId('987654321', { getGroupByTelegramId: noGroups, telegram });
  assert.equal(r.status, 'wrong_type');
});
