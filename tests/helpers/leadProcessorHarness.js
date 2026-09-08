/**
 * The shared fake world for services/facebookLeadEventProcessor.
 *
 * Every collaborator the processor touches — the data layer, Telegram, the
 * Graph fetch, Bitrix, the auto-message picker and the SMS sender — is replaced
 * through the require cache, so a test drives one lead end to end with no
 * network, no database and no secrets. `restore()` puts the cache back.
 *
 * It lives here because two suites need it: the ordering/duplicate-guard tests
 * in tests/facebookLeadEventProcessor.test.js and the per-recruiter message
 * tests in tests/facebookLeadRecruiterFlow.test.js.
 */
'use strict';

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const PATHS = {
  db: require.resolve('../../database/db'),
  crypto: require.resolve('../../lib/security/facebookCrypto'),
  mirror: require.resolve('../../services/facebookLeadSmsMirrorService'),
  telegramHtml: require.resolve('../../services/telegramHtml'),
  graph: require.resolve('../../services/facebookGraphService'),
  autoMessage: require.resolve('../../services/facebookLeadAutoMessageService'),
  sender: require.resolve('../../services/facebookLeadSmsSender'),
  bitrix: require.resolve('../../services/bitrix24Service'),
  processor: require.resolve('../../services/facebookLeadEventProcessor'),
};

const EVENT = {
  id: 1,
  page_id: '9001',
  event_type: 'leadgen',
  payload: { leadgenId: 'lg-1', value: { form_id: 'form-7' } },
};

function loadProcessor({
  connection = { page_name: 'Wenze Recruiting', telegram_group_id: '-1005555555555', access_token_encrypted: 'enc' },
  bitrix = { ok: true, bitrixId: 'B-1', entity: 'lead' },
  bitrixThrows = null,
  leadRow = { id: 77 },
  leadRecordThrows = null,
  autoSms = { isEnabled: true, template: 'Hi {first_name}', settings: {}, ruleLabel: 'default', repName: 'Jane Doe' },
  // What loadAutoMessageConfig() answers. `settings: null` is a deployment
  // that has never saved any auto-message configuration.
  autoMessageConfig = { settings: { id: 1, is_enabled: true }, rules: [] },
  // What resolveLeadSmsRecruiter answers. It runs BEFORE the template is
  // picked, because the assigned recruiter decides both the words and the
  // number.
  resolvedRecruiter = { recruiter: { id: 7, name: 'Jane Doe' }, assignedById: 17, reason: 'assigned' },
  senderResult = {
    smsResult: { ok: true, messageId: 'rc-own' },
    via: 'recruiter',
    recruiter: { id: 7, name: 'Jane Doe' },
    recruiterId: 7,
    assignedById: 17,
    fromNumber: '+15557770000',
    fallbackReason: null,
    fallbackNote: null,
  },
  senderUpdateThrows = null,
  // The duplicate guard's view of the world: an existing `leads` row, or the
  // failure of the lookup itself.
  existingLead = null,
  existingLeadError = null,
} = {}) {
  const calls = {
    telegram: [], notices: [], bitrix: [], leads: [], senderWrites: [], sends: [],
    textedChecks: [], resolves: [], autoSmsArgs: [], configLoads: [],
  };

  require.cache[PATHS.db] = {
    exports: {
      getFacebookPageConnectionByPageId: async () => connection,
      createLeadIfNew: async (row) => { calls.leads.push(row); if (leadRecordThrows) throw leadRecordThrows; return leadRow; },
      updateLeadBitrixResult: async (id, payload) => { calls.leads.push({ bitrixResult: { id, ...payload } }); },
      updateLeadSmsSender: async (id, payload) => {
        if (senderUpdateThrows) throw senderUpdateThrows;
        calls.senderWrites.push({ id, ...payload });
      },
      getLeadBySourceExternalId: async (source, externalId) => {
        calls.textedChecks.push({ source, externalId });
        if (existingLeadError) throw existingLeadError;
        return existingLead;
      },
    },
  };
  require.cache[PATHS.crypto] = { exports: { decryptText: () => 'page-token' } };
  require.cache[PATHS.mirror] = {
    exports: { sendAutoMessageSentNotice: async (telegram, chatId, payload) => { calls.notices.push(payload); return { ok: true }; } },
  };
  require.cache[PATHS.telegramHtml] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[PATHS.graph] = {
    exports: {
      fetchLeadById: async () => ({
        id: 'lg-1',
        field_data: [
          { name: 'full_name', values: ['Alex Driver'] },
          { name: 'phone_number', values: ['+15559998888'] },
        ],
      }),
    },
  };
  require.cache[PATHS.autoMessage] = {
    exports: {
      // Read BEFORE the Bitrix assignee, so a deployment with auto-SMS off
      // never pays the assignee-wait budget.
      loadAutoMessageConfig: async () => {
        calls.configLoads.push(true);
        return autoMessageConfig;
      },
      resolveAutoSmsForLead: async (args) => { calls.autoSmsArgs.push(args); return autoSms; },
      LEGACY_HARDCODED_TEMPLATE: 'legacy',
    },
  };
  require.cache[PATHS.sender] = {
    exports: {
      resolveLeadSmsRecruiter: async (args) => {
        calls.resolves.push(args);
        return typeof resolvedRecruiter === 'function' ? resolvedRecruiter(args) : resolvedRecruiter;
      },
      sendResolvedLeadSms: async (args) => {
        // Flattened so the assertions read the way the flow does: which lead,
        // which CRM record the sender was resolved from, and what was sent.
        const resolveArgs = calls.resolves[calls.resolves.length - 1] || {};
        const flat = { ...args, bitrixId: resolveArgs.bitrixId ?? null, entity: resolveArgs.entity };
        calls.sends.push(flat);
        if (typeof senderResult === 'function') return senderResult(flat);
        return senderResult;
      },
    },
  };
  require.cache[PATHS.bitrix] = {
    exports: {
      createCrmRecordFromLead: async (args) => {
        calls.bitrix.push(args);
        if (bitrixThrows) throw bitrixThrows;
        return bitrix;
      },
    },
  };
  delete require.cache[PATHS.processor];
  const processor = require(PATHS.processor);
  const telegram = { sendMessage: async (chatId, text) => { calls.telegram.push({ chatId, text }); return { message_id: calls.telegram.length }; } };
  const restore = () => { for (const path of Object.values(PATHS)) delete require.cache[path]; };
  return { processor, telegram, calls, restore };
}

module.exports = { PATHS, EVENT, loadProcessor };
