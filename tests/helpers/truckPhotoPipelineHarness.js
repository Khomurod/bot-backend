'use strict';

/**
 * The pipeline harness shared by tests/truckPhotoPipeline*.test.js: the
 * database and the model replaced, the REAL Telegram senders
 * (services/truckPhotos/deliver.js) talking to a fake client that logs every
 * call. Names and ids are made up.
 */

const deliver = require('../../services/truckPhotos/deliver');

const GROUP_CHAT = '-100555';
const RECIPIENT = '777000';
const WORD_AT = Date.parse('2026-11-06T16:00:00Z');

function fakeTelegram({ refuseDocument = () => false } = {}) {
  const log = [];
  let documents = 0;
  return {
    log,
    async callApi(method, payload) {
      log.push({ method, chat: String(payload.chat_id), payload });
      if (method === 'sendDocument') {
        documents += 1;
        if (refuseDocument(documents)) {
          throw Object.assign(new Error('Forbidden'), { response: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } });
        }
      }
      return { message_id: 900 + log.length };
    },
    async sendMessage(chat, text) { log.push({ method: 'sendMessage', chat: String(chat), text }); return { message_id: 1 }; },
    async setMessageReaction(chat, messageId, reaction) {
      log.push({ method: 'setMessageReaction', chat: String(chat), messageId, reaction });
      return true;
    },
  };
}

function photo(messageId, minutesBefore, over = {}) {
  return {
    id: messageId * 10, chatId: GROUP_CHAT, messageId, mediaGroupId: null, fromUserId: '5001', fromName: 'Jerome Joyner',
    fileId: `file-${messageId}`, fileUniqueId: `u-${messageId}`, kind: 'photo',
    sentAt: new Date(WORD_AT - minutesBefore * 60_000), reportId: null, ...over,
  };
}

const ALBUM_AND_SINGLES = [
  photo(10, 30, { mediaGroupId: 'A' }), photo(11, 30, { mediaGroupId: 'A' }), photo(12, 30, { mediaGroupId: 'A' }),
  photo(15, 10), photo(16, 5),
];

function harness(over = {}) {
  const telegram = fakeTelegram(over.telegram);
  const calls = {
    finish: [], marked: [], handover: 0, filter: 0, built: [], order: [], thumbs: [], prepared: [],
  };
  const photos = over.photos ?? ALBUM_AND_SINGLES;
  const deps = {
    getSettings: async () => ({
      enabled: true, recipientTelegramId: RECIPIENT, lookbackHours: 3, maxPhotosPerPdf: 60, ...over.settings,
    }),
    getPhotoByMessage: async (_chat, id) => photos.find((p) => p.messageId === id) || null,
    listPhotosSince: async (chat, since, limit, until) => { calls.listed = { chat, since, until }; return photos; },
    markPhotosInReport: async (ids) => { calls.marked.push(...ids); calls.order.push('mark'); return ids.length; },
    finishReport: async (_id, record) => { calls.finish.push(record); calls.order.push(`finish:${record.status}`); return true; },
    lastSentOutbound: async () => over.outbound ?? null,
    readHandover: async () => { calls.handover += 1; return over.handover ?? { verdict: 'yes', provider: 'groq' }; },
    filterPhotos: async (jpegs) => {
      calls.filter += 1;
      return over.filter ? over.filter(jpegs) : { excluded: new Set(), answered: 0, providers: [] };
    },
    prepareThumbnails: async (list) => { calls.thumbs.push(...list.map((v) => v.thumbFileId)); return list.map(() => null); },
    preparePhotos: over.preparePhotos || (async (list) => {
      calls.prepared.push(...list.map((p) => p.fileId));
      return {
        ready: list.map((p) => ({ photo: p, jpeg: Buffer.from(`jpeg-${p.messageId}`), width: 4, height: 3 })),
        unreadable: over.unreadable ?? 0,
      };
    }),
    buildPdf: async (args) => { calls.built.push(args); calls.order.push('build'); return Buffer.from('%PDF'); },
    sendPdf: async (args) => { const out = await deliver.sendPdf(args); calls.order.push('send'); return out; },
    reactDelivered: async (args) => { calls.order.push('react'); return deliver.reactDelivered(args); },
    tellRecipient: async (args) => { calls.order.push('tell'); return deliver.tellRecipient(args); },
    now: () => WORD_AT + 5000,
  };
  const message = {
    message_id: 100, chat: { id: Number(GROUP_CHAT), type: 'supergroup' },
    from: { id: 7002, first_name: 'Kim', last_name: 'Rowe' }, date: WORD_AT / 1000, text: 'outbound', ...over.message,
  };
  const job = {
    reportId: 1, message, trigger: over.trigger ?? { kind: 'outbound', bare: true },
    group: { id: 3, group_name: 'Jerome Joyner 1' }, profile: { first_name: 'Jerome', last_name: 'Joyner', unit_number: '1' },
    telegram,
    ...over.job,
  };
  return { telegram, calls, deps, job };
}

/** Everything the bot sent into the driver's group other than the 👍. */
const groupWrites = (telegram) => telegram.log.filter((e) => e.chat === GROUP_CHAT && e.method !== 'setMessageReaction');
const reactions = (telegram) => telegram.log.filter((e) => e.method === 'setMessageReaction');

module.exports = {
  GROUP_CHAT, RECIPIENT, WORD_AT, fakeTelegram, photo, ALBUM_AND_SINGLES, harness, groupWrites, reactions,
};
