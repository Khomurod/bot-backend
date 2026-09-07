const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bitrixMultiField,
  normalizeMetaFieldKey,
  splitNameFromFieldMap,
  applyMappedFields,
  buildBitrixCrmFields,
  buildTrackingComments,
  buildLeadComments,
  humanizeMetaKey,
  buildAnswerLines,
  resetInertAssignedByWarning,
} = require('../services/bitrix24LeadMapper');
const { resetCatalogForTests } = require('../services/bitrix24FieldCatalog');

const sampleFieldMap = {
  full_name: 'Alice Example',
  email: 'alice@example.com',
  phone_number: '+15551234567',
  city: 'Chicago',
};

const sampleLeadData = {
  id: '12345',
  created_time: '2026-05-01T12:00:00+0000',
};

const sampleConnection = {
  page_id: '1094689073723410',
  page_name: 'WENZE Transport Services',
};

const baseBitrixConfig = {
  entity: 'lead',
  assignedById: '',
  sourceId: 'WEB',
  sourceDescription: 'Facebook / bot-backend',
  dealCategoryId: '',
  dealStageId: '',
};

const mockCatalog = {
  fields: {
    UF_CRM_EXPERIENCE: {
      type: 'enumeration',
      title: 'Years of driving experience',
      items: [
        { ID: '101', VALUE: 'Yes' },
        { ID: '102', VALUE: 'No' },
      ],
    },
    UF_CRM_CDL: {
      type: 'string',
      title: 'CDL-A over the road driver',
    },
  },
  statuses: [
    { STATUS_ID: 'NEW', NAME: 'New' },
    { STATUS_ID: 'INCOMING', NAME: 'INCOMING' },
  ],
};

test('bitrixMultiField returns undefined for empty values', () => {
  assert.equal(bitrixMultiField(''), undefined);
  assert.deepEqual(bitrixMultiField('+15551234567'), [
    { VALUE: '+15551234567', VALUE_TYPE: 'WORK' },
  ]);
});

test('normalizeMetaFieldKey collapses punctuation and case', () => {
  assert.equal(normalizeMetaFieldKey('Phone'), 'phone');
  assert.equal(normalizeMetaFieldKey('  Are You CDL-A? '), 'are_you_cdl_a');
});

test('splitNameFromFieldMap splits full_name into first and last', () => {
  assert.deepEqual(splitNameFromFieldMap({ full_name: 'Alice Example' }), {
    firstName: 'Alice',
    lastName: 'Example',
  });
  assert.deepEqual(splitNameFromFieldMap({ first_name: 'Bob', last_name: 'Smith' }), {
    firstName: 'Bob',
    lastName: 'Smith',
  });
});

test('applyMappedFields maps custom UF field and not COMMENTS', () => {
  const mapConfig = {
    defaults: {
      email: 'EMAIL',
      do_you_have_2_years_of_experience: { bitrixField: 'UF_CRM_EXPERIENCE' },
    },
    custom: {},
  };
  const { fields } = applyMappedFields(
    { email: 'a@b.com', do_you_have_2_years_of_experience: 'Yes' },
    mapConfig,
    mockCatalog,
  );
  assert.equal(fields.UF_CRM_EXPERIENCE, '101');
  assert.equal(fields.COMMENTS, undefined);
});

test('buildTrackingComments includes metadata only', () => {
  const comments = buildTrackingComments({
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'x1',
    formId: 'f1',
  });

  assert.match(comments, /Leadgen ID: x1/);
  assert.match(comments, /Form ID: f1/);
  assert.doesNotMatch(comments, /alice@example.com/);
  assert.doesNotMatch(comments, /Alice Example/);
});

test('buildLeadComments is alias for buildTrackingComments', () => {
  const comments = buildLeadComments({
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'x1',
    formId: 'f1',
  });
  assert.match(comments, /bot-backend/);
  assert.doesNotMatch(comments, /Custom Question/);
});

test('buildBitrixCrmFields maps lead fields for crm.lead.add', () => {
  const fields = buildBitrixCrmFields({
    fieldMap: sampleFieldMap,
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'leadgen-abc',
    formId: 'form-11',
    bitrixConfig: baseBitrixConfig,
  });

  assert.equal(fields.TITLE, 'Facebook Lead – Alice Example');
  assert.equal(fields.NAME, 'Alice');
  assert.equal(fields.LAST_NAME, 'Example');
  assert.deepEqual(fields.PHONE, [{ VALUE: '+15551234567', VALUE_TYPE: 'WORK' }]);
  assert.deepEqual(fields.EMAIL, [{ VALUE: 'alice@example.com', VALUE_TYPE: 'WORK' }]);
  assert.equal(fields.SOURCE_ID, 'WEB');
  assert.match(fields.COMMENTS, /Leadgen ID: leadgen-abc/);
  assert.match(fields.COMMENTS, /Form ID: form-11/);
  assert.match(fields.COMMENTS, /WENZE Transport Services/);
  assert.doesNotMatch(fields.COMMENTS, /Chicago/);
});

test('buildBitrixCrmFields uses committed field-map statusId over BITRIX24_STATUS_ID env', () => {
  const originalStatus = process.env.BITRIX24_STATUS_ID;
  process.env.BITRIX24_STATUS_ID = 'CONFIGURED_INCOMING';

  delete require.cache[require.resolve('../services/bitrix24FieldMapLoader')];
  delete require.cache[require.resolve('../services/bitrix24LeadMapper')];
  const { buildBitrixCrmFields: buildFresh } = require('../services/bitrix24LeadMapper');

  const fields = buildFresh({
    fieldMap: { email: 'a@b.com' },
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'lg',
    formId: '',
    bitrixConfig: baseBitrixConfig,
  });
  // config/bitrix24LeadFieldMap.json pins statusId "NEW" for the Wenze portal
  // (no INCOMING stage exists there), which is authoritative over the env value.
  assert.equal(fields.STATUS_ID, 'NEW');

  if (originalStatus !== undefined) process.env.BITRIX24_STATUS_ID = originalStatus;
  else delete process.env.BITRIX24_STATUS_ID;
  delete require.cache[require.resolve('../services/bitrix24FieldMapLoader')];
  delete require.cache[require.resolve('../services/bitrix24LeadMapper')];
});

test('buildBitrixCrmFields uses committed field-map statusId over catalog fallback', () => {
  const originalStatus = process.env.BITRIX24_STATUS_ID;
  delete process.env.BITRIX24_STATUS_ID;
  delete require.cache[require.resolve('../services/bitrix24FieldMapLoader')];
  delete require.cache[require.resolve('../services/bitrix24LeadMapper')];
  const { buildBitrixCrmFields: buildFresh } = require('../services/bitrix24LeadMapper');

  const fields = buildFresh({
    fieldMap: { email: 'a@b.com' },
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'lg',
    formId: '',
    bitrixConfig: baseBitrixConfig,
    catalog: mockCatalog,
  });
  // The committed statusId "NEW" wins; the catalog INCOMING fallback only applies
  // when no statusId is configured in the field map.
  assert.equal(fields.STATUS_ID, 'NEW');

  if (originalStatus !== undefined) process.env.BITRIX24_STATUS_ID = originalStatus;
  delete require.cache[require.resolve('../services/bitrix24FieldMapLoader')];
  delete require.cache[require.resolve('../services/bitrix24LeadMapper')];
});

test('buildBitrixCrmFields resolves custom fields via matchTitle', () => {
  const fields = buildBitrixCrmFields({
    fieldMap: {
      are_you_cdl_a_over_the_road_driver: 'Yes',
      do_you_have_2_years_of_experience: 'No',
    },
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'lg',
    formId: '',
    bitrixConfig: baseBitrixConfig,
    catalog: mockCatalog,
  });

  assert.equal(fields.UF_CRM_CDL, 'Yes');
  assert.equal(fields.UF_CRM_EXPERIENCE, '102');
  assert.doesNotMatch(fields.COMMENTS || '', /CDL/);
});

test('buildBitrixCrmFields normalizes Phone key variant', () => {
  const fields = buildBitrixCrmFields({
    fieldMap: { Phone: '+15550001111', email: 'x@y.com' },
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: '',
    formId: '',
    bitrixConfig: baseBitrixConfig,
  });

  assert.deepEqual(fields.PHONE, [{ VALUE: '+15550001111', VALUE_TYPE: 'WORK' }]);
});

test('resolveFieldMapConfig merges per-form overrides', () => {
  const original = process.env.BITRIX24_FIELD_MAP_BY_FORM_ID;
  process.env.BITRIX24_FIELD_MAP_BY_FORM_ID = JSON.stringify({
    'form-override': {
      statusId: 'FORM_INCOMING',
      custom: { fleet_size: { bitrixField: 'UF_CRM_FLEET' } },
    },
  });

  delete require.cache[require.resolve('../services/bitrix24FieldMapLoader')];
  const { resolveFieldMapConfig: resolveFresh } = require('../services/bitrix24FieldMapLoader');
  const cfg = resolveFresh('form-override');

  assert.equal(cfg.statusId, 'FORM_INCOMING');
  assert.equal(cfg.custom.fleet_size.bitrixField, 'UF_CRM_FLEET');
  assert.ok(cfg.custom.do_you_have_2_years_of_experience);

  if (original !== undefined) process.env.BITRIX24_FIELD_MAP_BY_FORM_ID = original;
  else delete process.env.BITRIX24_FIELD_MAP_BY_FORM_ID;
  delete require.cache[require.resolve('../services/bitrix24FieldMapLoader')];
});

test('buildBitrixCrmFields includes deal category and stage when entity is deal', () => {
  const fields = buildBitrixCrmFields({
    fieldMap: sampleFieldMap,
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'leadgen-abc',
    formId: '',
    bitrixConfig: {
      ...baseBitrixConfig,
      entity: 'deal',
      dealCategoryId: '42',
      dealStageId: 'C1:NEW',
    },
  });

  assert.equal(fields.CATEGORY_ID, 42);
  assert.equal(fields.STAGE_ID, 'C1:NEW');
  // STATUS_ID is a LEAD field. A deal's stage is STAGE_ID, so sending both
  // would be at best ignored and at worst a rejected record.
  assert.equal(fields.STATUS_ID, undefined, 'a deal must not carry a lead status');
});

test('a lead still gets its STATUS_ID — the deal rule must not cost leads theirs', () => {
  const fields = buildBitrixCrmFields({
    fieldMap: sampleFieldMap,
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'leadgen-abc',
    formId: '',
    bitrixConfig: { ...baseBitrixConfig, entity: 'lead' },
  });
  // The value comes from the resolved field map, not from this test — what
  // matters is that a lead still carries one at all.
  assert.ok(fields.STATUS_ID, 'a lead must still carry its status');
  assert.equal(fields.CATEGORY_ID, undefined);
  assert.equal(fields.STAGE_ID, undefined);
});

test.after(() => {
  resetCatalogForTests();
});

/**
 * AN ANSWER WITH NOWHERE TO GO MUST NOT VANISH.
 *
 * The Facebook form asks the two questions a recruiter actually screens on —
 * "2 years of experience?", "CDL-A over the road?" — and the mapper can only
 * fill Bitrix fields that exist. The portal has none (see
 * config/bitrix24LeadFieldMap.discovered.json: "crm.lead.userfield.list
 * returned no custom fields"), so those answers used to produce a console
 * warning and nothing else: the recruiter opened the lead in Bitrix and saw a
 * name and a phone number, as if the driver had answered nothing.
 */
test('answers with no Bitrix field are carried in COMMENTS, not dropped', () => {
  const fields = buildBitrixCrmFields({
    fieldMap: {
      full_name: 'Alex Driver',
      phone_number: '+15559998888',
      do_you_have_2_years_of_experience: 'Yes',
      are_you_cdl_a_over_the_road_driver: 'Yes, CDL-A OTR',
    },
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'lg-1',
    formId: '',
    bitrixConfig: baseBitrixConfig,
    catalog: null,
  });

  assert.match(fields.COMMENTS, /Answers not stored in a Bitrix field:/);
  assert.match(fields.COMMENTS, /Do you have 2 years of experience: Yes/);
  assert.match(fields.COMMENTS, /Are you cdl a over the road driver: Yes, CDL-A OTR/);
  // The provenance lines are still there, after the answers.
  assert.match(fields.COMMENTS, /Leadgen ID: lg-1/);
  assert.ok(
    fields.COMMENTS.indexOf('Do you have 2 years') < fields.COMMENTS.indexOf('Leadgen ID'),
    'the answers come first — they are what a recruiter reads',
  );
});

test('an answer that DID reach a field is not repeated in COMMENTS', () => {
  const fields = buildBitrixCrmFields({
    fieldMap: { full_name: 'Alex Driver', phone_number: '+15559998888', email: 'a@b.c' },
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'lg-1',
    formId: '',
    bitrixConfig: baseBitrixConfig,
    catalog: null,
  });
  assert.doesNotMatch(fields.COMMENTS, /Answers not stored/);
  assert.doesNotMatch(fields.COMMENTS, /15559998888/, 'the phone went into PHONE');
});

test('buildAnswerLines skips what was mapped, and what is empty', () => {
  const lines = buildAnswerLines(
    { full_name: 'Alex', experience: 'Yes', blank: '', cdl: 'No' },
    new Set(['full_name']),
  );
  assert.deepEqual(lines, ['Experience: Yes', 'Cdl: No']);
});

test('humanizeMetaKey turns a Meta key into something readable', () => {
  assert.equal(humanizeMetaKey('do_you_have_2_years_of_experience'), 'Do you have 2 years of experience');
  assert.equal(humanizeMetaKey('cdl'), 'Cdl');
  assert.equal(humanizeMetaKey(''), '');
  assert.equal(humanizeMetaKey(null), '');
});

test('buildTrackingComments without answers is unchanged', () => {
  const comments = buildTrackingComments({
    leadData: sampleLeadData, connection: sampleConnection, leadgenId: 'lg-1', formId: '7',
  });
  assert.doesNotMatch(comments, /Answers not stored/);
  assert.match(comments, /^Facebook lead \(bot-backend\)/);
});

/**
 * A NAME IN BITRIX24_ASSIGNED_BY_ID IS INERT, and used to be silently so.
 * Bitrix only accepts the numeric user id, so the production default
 * ("Tom Robinson") has never assigned anything — every lead goes to the
 * webhook owner. That matters more now: the assignee is what decides which
 * recruiter's number texts the driver.
 */
test('a non-numeric assignee is ignored, and warned about exactly once', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { if (String(args[0]).includes('ASSIGNED_BY_ID')) warnings.push(args.join(' ')); };
  resetInertAssignedByWarning();
  try {
    const build = (assignedById) => buildBitrixCrmFields({
      fieldMap: { full_name: 'Alex Driver' },
      leadData: sampleLeadData,
      connection: sampleConnection,
      leadgenId: 'lg-1',
      formId: '',
      bitrixConfig: { ...baseBitrixConfig, assignedById },
      catalog: null,
    });

    const first = build('Tom Robinson');
    assert.equal(first.ASSIGNED_BY_ID, undefined, 'a name cannot be a Bitrix user id');
    build('Tom Robinson');
    build('Tom Robinson');
    assert.equal(warnings.length, 1, 'this runs per lead — a repeated warning is one nobody reads');
    assert.match(warnings[0], /"Tom Robinson"/);
    assert.match(warnings[0], /company\/personal\/user/, 'says where to find the real id');

    // A real id still works, and a blank one is silent (a rule assigns).
    assert.equal(build('17').ASSIGNED_BY_ID, 17);
    resetInertAssignedByWarning();
    warnings.length = 0;
    assert.equal(build('').ASSIGNED_BY_ID, undefined);
    assert.deepEqual(warnings, [], 'not set is the expected setup, not a problem');
  } finally {
    console.warn = original;
    resetInertAssignedByWarning();
  }
});
