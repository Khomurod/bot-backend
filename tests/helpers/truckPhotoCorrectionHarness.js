'use strict';

/**
 * Fakes for Truck Photos' corrections (tests/truckPhotoRebuild.test.js,
 * truckPhotoCorrection.test.js): a report as the database keeps it, the items
 * its last version held, and every dependency the rebuild and the correction
 * reach — recording what they were asked. Names and ids are made up.
 */

const RECIPIENT = '777000';
const GROUP_CHAT = '-100555';
const AT = (minutes) => new Date(Date.UTC(2026, 10, 19, 21, minutes));

function photo(id, minutes, over = {}) {
  return {
    id, chatId: GROUP_CHAT, messageId: id, mediaGroupId: null, fromUserId: '5001', fromName: 'Marco Jose',
    fileId: `file-${id}`, kind: 'photo', sentAt: AT(minutes), reportId: 9, ...over,
  };
}

/** The report's last version: three truck photos, a form page, a document left out, a video. */
function itemsV1() {
  return [
    { place: 'truck', position: 1, verdict: { kind: 'truck_outside', confidence: 95 }, photo: photo(1, 0) },
    { place: 'truck', position: 2, verdict: { kind: 'cab_inside', confidence: 90 }, photo: photo(2, 1) },
    { place: 'truck', position: 3, verdict: null, photo: photo(3, 2) },
    { place: 'form', position: 1, verdict: { kind: 'handover_form', confidence: 95 }, photo: photo(4, 3, { fromName: 'Eddy Murphy' }) },
    { place: 'left_out', position: null, verdict: { kind: 'document', confidence: 95 }, photo: photo(5, 4, { fromName: 'Eddy Murphy' }) },
    { place: 'video', position: 1, verdict: null, photo: photo(6, 5, { kind: 'video', thumbFileId: null }) },
  ];
}

function report(over = {}) {
  return {
    id: 9, chatId: GROUP_CHAT, groupId: 3, groupName: 'WENZE UNIT # 027 FRANTZ ARTHUS', triggerMessageId: 100,
    kind: 'outbound', status: 'sent', version: 1, edits: {}, photosFrom: AT(-180), photosUntil: AT(10),
    triggeredByName: 'Marvin Jackson', createdAt: AT(10), ...over,
  };
}

function fakes(over = {}) {
  const calls = {
    sorted: [], built: [], sent: [], saved: [], recorded: [], marked: [], told: [], reactions: [], cleared: [],
    listed: [], ownerTold: [], recordedMessages: [],
  };
  let messageId = 900;
  const deps = {
    getSettings: async () => ({
      enabled: true, recipientTelegramId: RECIPIENT, editorTelegramIds: ['4444'], maxPhotosPerPdf: 60, lookbackHours: 3, ...over.settings,
    }),
    findByMessage: async () => (over.found === undefined ? { report: report(over.report), version: 1, part: 1 } : over.found),
    findByTrigger: async () => (over.byTrigger === undefined ? report(over.report) : over.byTrigger),
    getReport: async () => report(over.report),
    listItems: async () => (over.items ?? itemsV1()),
    readDriverContext: async () => ({ profile: { first_name: 'Frantz', last_name: 'Arthus', unit_number: '088', driver_type: 'company_driver', ...over.profile } }),
    readBoardTrucks: async () => [],
    lastSentOutbound: async () => null,
    listPhotosSince: async (chat, from, limit, until) => { calls.listed.push({ chat, from, until }); return over.window ?? []; },
    readCorrection: async (args) => { calls.read = args; return over.read ?? { status: 'ok', actions: [{ do: 'truck_number', unit: '027' }], provider: 'groq' }; },
    sortPhotos: async (jpegs) => {
      calls.sorted.push(jpegs.map(String));
      return over.sort ? over.sort(jpegs) : { verdicts: jpegs.map(() => ({ kind: 'truck_outside', confidence: 90 })), answered: 1, providers: ['openrouter'], stopped: null };
    },
    preparePhotos: async (list) => ({
      ready: list.map((p) => ({ photo: p, jpeg: Buffer.from(`jpeg-${p.id}`), width: 4, height: 3 })), unreadable: 0,
    }),
    prepareThumbnails: async (list) => list.map(() => null),
    buildPdf: async (args) => { calls.built.push(args); return Buffer.from('%PDF'); },
    sendPdf: async (args) => {
      calls.sent.push(args);
      if (over.refuseSend) throw Object.assign(new Error('Forbidden'), { response: { error_code: 403 } });
      messageId += 1;
      return { message_id: messageId };
    },
    saveVersion: async (id, record) => { calls.saved.push({ id, ...record }); return over.raced ? false : true; },
    recordVersion: async (args) => { calls.recorded.push(args); },
    recordMessages: async (args) => { calls.recordedMessages.push(args); },
    latestPdfMessage: async () => 555,
    setReportPhotos: async (id, ids) => { calls.marked.push({ id, ids }); },
    tellOwnerUnchecked: async (args) => { calls.ownerTold.push(args); return { notified: true }; },
    tellRecipient: async (args) => {
      calls.told.push(args);
      if (over.refuseTell && over.refuseTell(args)) return false;
      messageId += 1;
      return messageId;
    },
    clearReaction: async (args) => { calls.cleared.push(args); return true; },
    react: async (telegram, chatId, msgId, emoji) => { calls.reactions.push([String(chatId), msgId, emoji]); return true; },
    queue: (job) => job(),
    ...over.deps,
  };
  // eslint-disable-next-line global-require
  deps.rebuild = over.rebuild || require('../../services/truckPhotos/rebuild');
  return { calls, deps };
}

module.exports = {
  RECIPIENT, GROUP_CHAT, AT, photo, itemsV1, report, fakes,
};
