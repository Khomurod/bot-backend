'use strict';

/**
 * An in-memory recruiting group for the Safety Approvals reviewer tests: the
 * message store and the review store faked, a Telegram that records what it
 * was asked, and a model whose answer still goes through the real
 * lib/safetyApprovals/reading.js. Names, numbers and file ids are made up.
 *
 * Load it BEFORE requiring the reviewer: it puts the fakes in require.cache.
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const state = {
  rows: [], announcements: [], failComplete: false, finished: [], retried: [],
};

const CHAT = '-1001234567890';
const SAFETY = '900';
const RECRUITER = '500';
const NOW = Date.parse('2026-10-16T15:00:00Z');
const AGO = (s) => new Date(NOW - s * 1000);
const SETTINGS = { enabled: true, chatId: CHAT, topicId: 45, safetyUserIds: [SAFETY] };

const find = (chatId, id) => state.rows.find((r) => r.chatId === chatId && r.messageId === Number(id)) || null;

stub('database/safetyApprovals/messages.js', {
  getMessage: async (chatId, id) => find(chatId, id),
  getMediaGroup: async (chatId, mg) => state.rows.filter((r) => r.chatId === chatId && r.mediaGroupId === mg),
  listSenderMessagesAround: async ({ chatId, fromUserId }) => state.rows.filter((r) => r.chatId === chatId
    && r.fromUserId === fromUserId && !r.replyToMessageId),
  listSafetyReplies: async ({ chatId, postMessageIds, safetyUserIds }) => {
    const direct = state.rows.filter((r) => r.chatId === chatId && postMessageIds.includes(r.replyToMessageId)
      && safetyUserIds.includes(r.fromUserId));
    const groups = new Set(direct.map((r) => r.mediaGroupId).filter(Boolean));
    return state.rows.filter((r) => direct.includes(r) || (r.mediaGroupId && groups.has(r.mediaGroupId)));
  },
  listRecentGeneral: async ({ chatId, beforeMessageId, limit }) => state.rows
    .filter((r) => r.chatId === chatId && r.threadId === null && r.messageId < beforeMessageId)
    .sort((a, b) => b.messageId - a.messageId)
    .slice(0, limit),
});
stub('database/safetyApprovals/reviews.js', {
  finishReview: async (review, fields) => { state.finished.push({ id: review.id, ...fields }); return true; },
  retryReview: async (review, fields) => { state.retried.push({ id: review.id, ...fields }); return true; },
  reserveAnnouncement: async (a) => {
    const last = state.announcements
      .filter((x) => x.chatId === a.chatId && x.postMessageId === a.postMessageId && x.driverKey === a.driverKey).at(-1);
    if (last && last.decision === a.decision) return null;
    state.announcements.push({ ...a, id: state.announcements.length + 1, topicMessageIds: null });
    return { id: state.announcements.length };
  },
  completeAnnouncement: async (id, ids) => {
    if (state.failComplete) throw new Error('database is down');
    state.announcements.find((a) => a.id === id).topicMessageIds = ids;
  },
  releaseAnnouncement: async (id) => { state.announcements = state.announcements.filter((a) => a.id !== id); },
});

const { processReview } = require('../../services/safetyApprovals/reviewer');
const { readSafetyReply, AiUnavailableError } = require('../../services/safetyApprovals/aiReading');

function msg(fields) {
  return {
    chatId: CHAT, threadId: null, mediaGroupId: null, fromName: null, text: null,
    photos: [], documents: [], replyToMessageId: null, sentAt: AGO(600), editedAt: null, ...fields,
  };
}
const photo = (id) => [{ file_id: id, file_size: 1000 }];
const pdf = (id, name) => [{ file_id: id, file_unique_id: `u-${id}`, file_name: name, mime_type: 'application/pdf' }];

/** Renata's post: the CDL front with the words, then the back. */
function soloPost() {
  return [
    msg({ messageId: 10, fromUserId: RECRUITER, fromName: 'Kim R | Recruiting', mediaGroupId: 'p1', photos: photo('cdl-front'),
      text: 'Company Driver - 80 CPM\nRenata Ilves\n555-010-7788\nexp 3 years' }),
    msg({ messageId: 11, fromUserId: RECRUITER, fromName: 'Kim R | Recruiting', mediaGroupId: 'p1', photos: photo('cdl-back') }),
  ];
}
/** Safety's answer: two PDFs, the second carrying the words. */
function safetyAlbum(text, { replyTo = 11, at = 300 } = {}) {
  return [
    msg({ messageId: 20, fromUserId: SAFETY, fromName: 'A. Davis', mediaGroupId: 's1', replyToMessageId: replyTo,
      documents: pdf('psp', 'R ILVES PSP.pdf'), sentAt: AGO(at) }),
    msg({ messageId: 21, fromUserId: SAFETY, fromName: 'A. Davis', mediaGroupId: 's1',
      documents: pdf('mvr', 'R ILVES MVR.pdf'), text, sentAt: AGO(at) }),
  ];
}

function fakeTelegram() {
  const calls = [];
  let next = 680;
  return {
    calls,
    sendMediaGroup: async (chatId, media, extra) => {
      calls.push({ kind: 'album', chatId, media, extra });
      return media.map(() => ({ message_id: (next += 1) }));
    },
    sendDocument: async (chatId, doc, extra) => { calls.push({ kind: 'doc', chatId, doc, extra }); return { message_id: (next += 1) }; },
    sendPhoto: async (chatId, photo, extra) => { calls.push({ kind: 'photo', chatId, photo, extra }); return { message_id: (next += 1) }; },
    sendMessage: async (chatId, text, extra) => { calls.push({ kind: 'text', chatId, text, extra }); return { message_id: (next += 1) }; },
  };
}

/** A model that answers `answer`, through the real verifier. */
function model(answer) {
  return (args) => readSafetyReply(args, {
    runCapability: async () => ({ parsed: answer, provider: 'fake', model: 'fake-1' }),
    prepareImagePart: async (buffer, mime) => ({ inline_data: { mime_type: mime, data: buffer.toString('base64') } }),
  });
}

/** A model that must not be asked. */
const noModel = () => { throw new Error('the model must not be asked'); };

function deps(extra = {}) {
  return {
    settings: SETTINGS,
    telegram: fakeTelegram(),
    download: async (fileId) => Buffer.from(`bytes:${fileId}`),
    now: () => NOW,
    readReply: noModel,
    pickPost: noModel,
    ...extra,
  };
}

const review = (fields = {}) => ({
  id: 1, chatId: CHAT, safetyKey: 'album:s1', postMessageId: 11, attempts: 1, revision: 0, createdAt: AGO(300), ...fields,
});

function reset(seed) {
  state.rows = seed;
  state.announcements = [];
  state.failComplete = false;
  state.finished.length = 0;
  state.retried.length = 0;
}

module.exports = {
  state, processReview, readSafetyReply, AiUnavailableError,
  CHAT, SAFETY, RECRUITER, NOW, AGO, SETTINGS,
  msg, photo, pdf, soloPost, safetyAlbum, fakeTelegram, model, noModel, deps, review, reset,
};
