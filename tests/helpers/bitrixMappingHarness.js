/**
 * Stubs for the Bitrix mapping suites.
 *
 * `services/recruiterBitrixMapping/*` reaches three places a unit test must
 * not: the config (for the webhook URL), bitrix24Service (for
 * isBitrixConfigured) and database/ringcentral (for the recruiter rows and the
 * writes). This installs all three in require.cache BEFORE the modules under
 * test are required, and hands back a `restore` that removes them again.
 *
 * Shared by tests/recruiterBitrixDirectory.test.js (reading `user.get`) and
 * tests/recruiterBitrixMapping.test.js (preview, apply and the endpoints),
 * which were one file until it crossed the 500-line limit.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const CONFIG_PATH = require.resolve('../../config/config');
const BITRIX_PATH = require.resolve('../../services/bitrix24Service');
const RC_PATH = require.resolve('../../database/ringcentral');
const DIR_PATH = require.resolve('../../services/recruiterBitrixMapping/directory');
const MAP_PATH = require.resolve('../../services/recruiterBitrixMapping');
const ROUTE_PATH = require.resolve('../../server/routes/recruiter/bitrixMappingRoutes');

/** A webhook whose PATH is a secret, so a test can assert it never leaks. */
const WEBHOOK = 'https://wenze.bitrix24.com/rest/1/super-secret-value/';

const bitrixRow = (id, name, lastName, extra = {}) => ({
  ID: String(id), NAME: name, LAST_NAME: lastName, ACTIVE: true, ...extra,
});

/** A fetch that answers user.get pages from a list of bodies, in order. */
function pagedFetch(pages) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const body = pages[calls.length - 1] ?? { result: [] };
    return { ok: body.__http !== false, status: body.__status || 200, json: async () => body };
  };
  return { impl, calls };
}

function loadModules({ enabled = true, webhookUrl = WEBHOOK, recruiters = [], onUpdate } = {}) {
  const realConfig = require('../../config/config');
  const seen = { updates: [] };

  require.cache[CONFIG_PATH] = {
    exports: { ...realConfig, bitrix24Enabled: enabled, bitrix24WebhookUrl: webhookUrl },
  };
  require.cache[BITRIX_PATH] = {
    exports: {
      isBitrixConfigured: () => Boolean(enabled && webhookUrl),
      normalizeWebhookBase: (u) => (u ? String(u).replace(/\/?$/, '/') : ''),
    },
  };
  require.cache[RC_PATH] = {
    exports: {
      listRecruitersForAdmin: async () => recruiters,
      updateRecruiter: async (id, payload) => {
        seen.updates.push({ id, payload });
        if (onUpdate) return onUpdate(id, payload);
        return { id, ...payload };
      },
    },
  };

  delete require.cache[DIR_PATH];
  delete require.cache[MAP_PATH];
  const directory = require(DIR_PATH);
  const mapping = require(MAP_PATH);
  const restore = () => {
    for (const p of [CONFIG_PATH, BITRIX_PATH, RC_PATH, DIR_PATH, MAP_PATH]) delete require.cache[p];
  };
  return { directory, mapping, seen, restore };
}

module.exports = {
  CONFIG_PATH, BITRIX_PATH, RC_PATH, DIR_PATH, MAP_PATH, ROUTE_PATH,
  WEBHOOK, bitrixRow, pagedFetch, loadModules,
};
