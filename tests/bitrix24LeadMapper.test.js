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

test('buildBitrixCrmFields sets STATUS_ID from BITRIX24_STATUS_ID env', () => {
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
  assert.equal(fields.STATUS_ID, 'CONFIGURED_INCOMING');

  if (originalStatus !== undefined) process.env.BITRIX24_STATUS_ID = originalStatus;
  else delete process.env.BITRIX24_STATUS_ID;
  delete require.cache[require.resolve('../services/bitrix24FieldMapLoader')];
  delete require.cache[require.resolve('../services/bitrix24LeadMapper')];
});

test('buildBitrixCrmFields sets STATUS_ID from catalog when statusId unset', () => {
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
  assert.equal(fields.STATUS_ID, 'INCOMING');

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
});

test.after(() => {
  resetCatalogForTests();
});
