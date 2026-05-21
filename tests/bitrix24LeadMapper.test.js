const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bitrixMultiField,
  splitNameFromFieldMap,
  buildBitrixCrmFields,
  buildLeadComments,
} = require('../services/bitrix24LeadMapper');

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

test('bitrixMultiField returns undefined for empty values', () => {
  assert.equal(bitrixMultiField(''), undefined);
  assert.deepEqual(bitrixMultiField('+15551234567'), [
    { VALUE: '+15551234567', VALUE_TYPE: 'WORK' },
  ]);
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

test('buildLeadComments lists custom fields and metadata', () => {
  const comments = buildLeadComments({
    fieldMap: { custom_question: 'Yes', full_name: 'Alice Example' },
    leadData: sampleLeadData,
    connection: sampleConnection,
    leadgenId: 'x1',
    formId: 'f1',
  });

  assert.match(comments, /Custom Question: Yes/);
  assert.match(comments, /Leadgen ID: x1/);
});
