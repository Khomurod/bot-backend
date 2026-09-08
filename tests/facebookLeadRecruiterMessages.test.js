/**
 * The optional per-recruiter Facebook-lead message.
 *
 * The rule this pins: WHO Bitrix assigned decides the words. When that
 * recruiter has written their own template it is used and `{rep_name}` is
 * their name; when they have not — blank, parked, no row, or no recruiter
 * resolved at all — the global time-based system decides exactly as it did
 * before, and the shared-number fallback is untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const DB_PATH = require.resolve('../database/db');
const SERVICE_PATH = require.resolve('../services/facebookLeadAutoMessageService');

const GLOBAL_SETTINGS = {
  id: 1,
  timezone: 'America/Chicago',
  is_enabled: true,
  rep_name: 'Tom',
  company_name: 'Wenze trucking company',
  position_label: 'OTR position',
  fallback_template: 'Global fallback from {rep_name}.',
};

const ALWAYS_ON_RULE = {
  id: 5,
  label: 'Working hours',
  days_of_week: [1, 2, 3, 4, 5, 6, 7],
  start_time_local: '00:00',
  end_time_local: '00:00', // start === end means "always" in isTimeInWindow
  message_template: 'Global rule from {rep_name}.',
  sort_order: 0,
  is_active: true,
};

/** Load the service with a faked data layer. */
function loadService({ settings = GLOBAL_SETTINGS, rules = [ALWAYS_ON_RULE], recruiterRows = {} } = {}) {
  require.cache[DB_PATH] = {
    exports: {
      getFacebookLeadAutoMessageSettings: async () => ({ settings, rules }),
      getFacebookLeadRecruiterMessage: async (id) => recruiterRows[id] || null,
    },
  };
  delete require.cache[SERVICE_PATH];
  const service = require(SERVICE_PATH);
  const restore = () => { delete require.cache[DB_PATH]; delete require.cache[SERVICE_PATH]; };
  return { service, restore };
}

const SOFIA = { id: 11, name: 'Sofia' };
const KIMBERLY = { id: 12, name: 'Kimberly' };

test('each recruiter gets their own template, and their own name in it', async () => {
  const { service, restore } = loadService({
    recruiterRows: {
      11: { recruiter_id: 11, message_template: 'Hi {first_name}, {rep_name} here about the {position}.' },
      12: { recruiter_id: 12, message_template: '{rep_name} from {company_name} — got a minute?' },
    },
  });
  const { buildTemplateContext, renderLeadSmsTemplate } = require('../services/facebookLeadSmsTemplate');
  try {
    const forSofia = await service.resolveAutoSmsForLead({ fieldMap: { first_name: 'Alex' }, recruiter: SOFIA });
    const forKim = await service.resolveAutoSmsForLead({ fieldMap: { first_name: 'Alex' }, recruiter: KIMBERLY });

    assert.equal(forSofia.source, 'recruiter');
    assert.equal(forKim.source, 'recruiter');
    assert.notEqual(forSofia.template, forKim.template);

    const render = (resolved) => renderLeadSmsTemplate(
      resolved.template,
      buildTemplateContext({ fieldMap: { first_name: 'Alex' }, settings: resolved.settings, repName: resolved.repName }),
    );
    assert.equal(render(forSofia), 'Hi Alex, Sofia here about the OTR position.');
    assert.equal(render(forKim), 'Kimberly from Wenze trucking company — got a minute?');
  } finally { restore(); }
});

test('a blank recruiter template falls back to the global time rule', async () => {
  const { service, restore } = loadService({
    recruiterRows: { 11: { recruiter_id: 11, message_template: '   ' } },
  });
  try {
    const resolved = await service.resolveAutoSmsForLead({ fieldMap: {}, recruiter: SOFIA });
    assert.equal(resolved.source, 'rule');
    assert.equal(resolved.template, ALWAYS_ON_RULE.message_template);
    // …but the name is still the recruiter's: they are the one texting.
    assert.equal(resolved.repName, 'Sofia');
  } finally { restore(); }
});

test('no recruiter at all keeps the global message and the settings rep name', async () => {
  const { service, restore } = loadService();
  const { buildTemplateContext, renderLeadSmsTemplate } = require('../services/facebookLeadSmsTemplate');
  try {
    const resolved = await service.resolveAutoSmsForLead({ fieldMap: {}, recruiter: null });
    assert.equal(resolved.source, 'rule');
    assert.equal(resolved.repName, '');
    assert.equal(
      renderLeadSmsTemplate(
        resolved.template,
        buildTemplateContext({ fieldMap: {}, settings: resolved.settings, repName: resolved.repName }),
      ),
      'Global rule from Tom.',
    );
  } finally { restore(); }
});

test('a database failure on the recruiter lookup never costs the lead its message', async () => {
  require.cache[DB_PATH] = {
    exports: {
      getFacebookLeadAutoMessageSettings: async () => ({ settings: GLOBAL_SETTINGS, rules: [ALWAYS_ON_RULE] }),
      getFacebookLeadRecruiterMessage: async () => { throw new Error('pool timeout'); },
    },
  };
  delete require.cache[SERVICE_PATH];
  const service = require(SERVICE_PATH);
  try {
    const resolved = await service.resolveAutoSmsForLead({ fieldMap: {}, recruiter: SOFIA });
    assert.equal(resolved.source, 'rule');
    assert.equal(resolved.template, ALWAYS_ON_RULE.message_template);
  } finally {
    delete require.cache[DB_PATH];
    delete require.cache[SERVICE_PATH];
  }
});

test('the master enable switch still governs recruiter templates', async () => {
  const { service, restore } = loadService({
    settings: { ...GLOBAL_SETTINGS, is_enabled: false },
    recruiterRows: { 11: { recruiter_id: 11, message_template: 'Sofia here.' } },
  });
  try {
    const resolved = await service.resolveAutoSmsForLead({ fieldMap: {}, recruiter: SOFIA });
    assert.equal(resolved.isEnabled, false, 'a recruiter template does not re-enable auto-SMS');
  } finally { restore(); }
});

test('validation rejects unknown placeholders but accepts a blank template', () => {
  const service = require('../services/facebookLeadAutoMessageService');
  assert.deepEqual(
    service.validateRecruiterMessagePayload([{ recruiter_id: 11, recruiter_name: 'Sofia', message_template: '' }]),
    [],
    'blank is how an admin removes an override',
  );
  const errors = service.validateRecruiterMessagePayload([
    { recruiter_id: 11, recruiter_name: 'Sofia', message_template: 'Hi {first_name} {dispatcher}' },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Sofia/);
  assert.match(errors[0], /dispatcher/);
});
