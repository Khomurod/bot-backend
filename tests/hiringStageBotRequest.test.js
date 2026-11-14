'use strict';

/**
 * lib/hiringStages/botRequest.js — when a message in the recruiting group is
 * a person asking the bot for a lead, which copy of the post is the current
 * one, and which reaction answers. Pure. The bot's username comes from
 * Telegram (ctx.botInfo), so these tests use a made-up one. Ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUEST_REACTIONS, mentionsBot, isBotRequestMessage, readBotRequest, postNeedsRefresh, requestReaction,
} = require('../lib/hiringStages/botRequest');
const { ALLOWED_REACTION_EMOJIS } = require('../services/autoReactionConstants');

const BOT = { id: 777000111, username: 'Wenze_Recruit_Bot', is_bot: true };
const CHAT = -1001234567890;
const SETTINGS = {
  enabled: true, stageProposalsEnabled: true, chatId: String(CHAT), topicId: 3, bitrixTopicId: 77, safetyUserIds: ['900'],
};
const POST = { message_id: 169, chat: { id: CHAT }, from: { id: 500, first_name: 'Kim', is_bot: false }, text: 'KWAME ASANTE' };

/** A reply to the post whose text mentions `@handle` at `offset`. */
function tagMessage(text = '@wenze_recruit_bot', over = {}) {
  const at = text.indexOf('@');
  return {
    message_id: 175,
    chat: { id: CHAT },
    from: { id: 4242, first_name: 'Ann', last_name: 'Lee', is_bot: false },
    date: 1794650700,
    text,
    entities: at >= 0 ? [{ type: 'mention', offset: at, length: text.slice(at).split(/\s/)[0].length }] : [],
    reply_to_message: POST,
    ...over,
  };
}
const ask = (message, settings = SETTINGS) => readBotRequest(message, { botInfo: BOT, settings });

test('a MENTION of the bot in the text\'s entities is a request — the bot\'s own username, any letter case', () => {
  const out = ask(tagMessage('please add him @WENZE_recruit_BOT'));
  assert.deepEqual(out.request, {
    replyToMessageId: 169, requestMessageId: 175, requestedByUserId: '4242', requestedByName: 'Ann Lee',
  });
  assert.ok(mentionsBot(tagMessage('@wenze_recruit_bot'), BOT));
  assert.ok(isBotRequestMessage(tagMessage(), BOT));
});

test('a mention in a photo\'s CAPTION entities counts too', () => {
  const caption = 'new lead @Wenze_Recruit_Bot';
  const out = ask(tagMessage(undefined, {
    text: undefined, entities: undefined, photo: [{ file_id: 'p' }], caption,
    caption_entities: [{ type: 'mention', offset: 9, length: 18 }],
  }));
  assert.equal(out.request?.replyToMessageId, 169);
});

test('a TEXT_MENTION of the bot\'s id counts; another user\'s does not', () => {
  const textMention = (id) => tagMessage('Wenze', { entities: [{ type: 'text_mention', offset: 0, length: 5, user: { id } }] });
  assert.ok(ask(textMention(BOT.id)).request);
  assert.equal(ask(textMention(12345)).reason, 'no_mention');
});

test('another @username, the bot\'s name inside a longer handle, or words alone are not a mention', () => {
  assert.equal(ask(tagMessage('@wenze_recruit_bot_old')).reason, 'no_mention');
  assert.equal(ask(tagMessage('@somebody_else')).reason, 'no_mention');
  assert.equal(ask(tagMessage('wenze_recruit_bot please', { entities: [] })).reason, 'no_mention');
  assert.equal(mentionsBot(tagMessage(), null), false, 'no botInfo: nothing mentions the bot');
  assert.equal(mentionsBot(tagMessage(), { id: 1 }), false, 'a username is never guessed');
});

test('NOT A REPLY: a mention on its own asks nothing — and stays data', () => {
  const lone = tagMessage('@wenze_recruit_bot', { reply_to_message: undefined });
  assert.equal(ask(lone).reason, 'not_a_reply');
  assert.equal(isBotRequestMessage(lone, BOT), false);
});

test('A BOT does not ask; neither does the ANONYMOUS ADMIN (GroupAnonymousBot)', () => {
  assert.equal(ask(tagMessage(undefined, { from: { id: 99, is_bot: true, username: 'other_bot' } })).reason, 'not_a_person');
  const anonymous = tagMessage(undefined, {
    from: { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' },
    sender_chat: { id: CHAT, type: 'supergroup', title: 'Recruiting' },
  });
  assert.equal(ask(anonymous).reason, 'not_a_person');
  assert.equal(ask(tagMessage(undefined, { from: undefined })).reason, 'not_a_person');
});

test('ANOTHER TOPIC is not General — and the "reply" to a topic\'s root is no reply', () => {
  const inTopic = tagMessage(undefined, { message_thread_id: 3, is_topic_message: true });
  assert.equal(ask(inTopic).reason, 'another_topic');
  const topicRoot = tagMessage(undefined, {
    message_thread_id: 3, is_topic_message: true, reply_to_message: { message_id: 3, forum_topic_created: { name: 'Approved' } },
  });
  assert.equal(ask(topicRoot).reason, 'another_topic');
  assert.equal(isBotRequestMessage(topicRoot, BOT), false);
});

test('THE SWITCHES: Safety Approvals off, stage proposals off, or no Bitrix topic → nothing', () => {
  assert.equal(ask(tagMessage(), { ...SETTINGS, enabled: false }).reason, 'switched_off');
  assert.equal(ask(tagMessage(), { ...SETTINGS, stageProposalsEnabled: false }).reason, 'switched_off');
  assert.equal(ask(tagMessage(), { ...SETTINGS, bitrixTopicId: null }).reason, 'no_bitrix_topic');
  assert.equal(ask(tagMessage(), null).reason, 'switched_off');
  assert.equal(ask(tagMessage(undefined, { chat: { id: -100999 } })).reason, 'another_chat');
});

test('an EDIT that adds the mention asks nothing (a new message asks)', () => {
  assert.equal(ask(tagMessage(undefined, { edit_date: 1794650800 })).reason, 'an_edit');
  assert.ok(isBotRequestMessage(tagMessage(undefined, { edit_date: 1794650800 }), BOT), 'still never data');
});

test('THE POST\'S CURRENT COPY: a newer edit or other words replace the stored one; an older copy never does', () => {
  const at = (iso) => new Date(iso);
  const stored = { text: 'KWAME ASANTE', editedAt: null };
  assert.equal(postNeedsRefresh(null, { text: 'x' }), true, 'never stored: recovered');
  assert.equal(postNeedsRefresh(stored, { text: 'KWAME ASANTE', editedAt: null }), false);
  assert.equal(postNeedsRefresh(stored, { text: 'KWAME ASANTE\n(555) 201-3344', editedAt: null }), true, 'other words');
  assert.equal(postNeedsRefresh(stored, { text: 'KWAME ASANTE', editedAt: at('2026-11-14T10:00:00Z') }), true, 'a newer edit');
  const edited = { text: 'new', editedAt: at('2026-11-14T10:05:00Z') };
  assert.equal(postNeedsRefresh(edited, { text: 'old', editedAt: at('2026-11-14T10:00:00Z') }), false, 'an older copy');
  assert.equal(postNeedsRefresh(edited, { text: 'newer', editedAt: at('2026-11-14T10:09:00Z') }), true);
  assert.equal(postNeedsRefresh(edited, { text: 'new', editedAt: at('2026-11-14T10:05:00Z') }), false, 'the same edit');
});

test('THE ANSWER: 👍 with a deal, 🤷 for a person, nothing while it will be read again — all reactions Telegram allows', () => {
  assert.equal(requestReaction({ hasDeal: true, status: 'retry' }), '👍');
  assert.equal(requestReaction({ hasDeal: true, status: 'done' }), '👍');
  assert.equal(requestReaction({ hasDeal: false, status: 'done' }), '🤷');
  assert.equal(requestReaction({ hasDeal: false, status: 'gave_up' }), '🤷');
  assert.equal(requestReaction({ hasDeal: false, status: 'retry' }), null);
  for (const emoji of Object.values(REQUEST_REACTIONS)) {
    assert.ok(ALLOWED_REACTION_EMOJIS.includes(emoji), `${emoji} is a reaction a bot may set`);
  }
  assert.equal(ALLOWED_REACTION_EMOJIS.includes('✅'), false, 'why "done" is 👍, not the ✅ the owner named');
});
