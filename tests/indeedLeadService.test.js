const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseIndeedName,
  parseContactFromText,
  ingestIndeedLead,
} = require('../services/indeedLeadService');

test('parseIndeedName: "<Name> applied" subject', () => {
  assert.equal(parseIndeedName({ subject: 'John Doe applied to your CDL Driver job' }), 'John Doe');
});

test('parseIndeedName: "application from" subject', () => {
  assert.equal(parseIndeedName({ subject: 'New application from Jane Smith for Driver' }), 'Jane Smith');
});

test('parseIndeedName: body "Name:" fallback', () => {
  assert.equal(
    parseIndeedName({ subject: 'You have a new candidate', body: 'Position: Driver\nName: Carlos Ruiz\nApplied today' }),
    'Carlos Ruiz'
  );
});

test('parseIndeedName: falls back to generic label', () => {
  assert.equal(parseIndeedName({ subject: 'A candidate applied', body: 'see dashboard' }), 'Indeed Applicant');
});

test('parseContactFromText: extracts phone and email', () => {
  const r = parseContactFromText('Call me at (470) 480-4679 or email john.doe@gmail.com');
  assert.equal(r.phone, '(470) 480-4679');
  assert.equal(r.email, 'john.doe@gmail.com');
  assert.equal(r.emailIsRelay, false);
});

test('parseContactFromText: flags Indeed relay email', () => {
  const r = parseContactFromText('reply to abc123@indeedemail.com');
  assert.equal(r.emailIsRelay, true);
});

test('parseContactFromText: rejects non-phone digit runs', () => {
  const r = parseContactFromText('Applied on 2026 for job 12345');
  assert.equal(r.phone, null);
});

function makeFakeDb() {
  const state = { inserted: [], updates: [], existing: new Set() };
  return {
    state,
    async createLeadIfNew(lead) {
      const key = `${lead.source}:${lead.externalId}`;
      if (state.existing.has(key)) return null;
      state.existing.add(key);
      // Mirror the real DB which RETURNING * gives snake_case columns.
      const row = {
        id: state.inserted.length + 1,
        source: lead.source,
        external_id: lead.externalId,
        full_name: lead.fullName,
        email: lead.email,
        phone: lead.phone,
        job_title: lead.jobTitle,
        message: lead.message,
      };
      state.inserted.push(row);
      return row;
    },
    async updateLeadBitrixResult(id, payload) {
      state.updates.push({ id, ...payload });
    },
  };
}

test('ingestIndeedLead: new lead → records and creates Bitrix record', async () => {
  const fakeDb = makeFakeDb();
  const crmCalls = [];
  const result = await ingestIndeedLead(
    { messageId: 'msg1', subject: 'Bob Lee applied to Driver', body: '', resumePdfBase64: '' },
    {
      db: fakeDb,
      extractResumeContact: async () => ({ phone: '+14704804679', email: null, emailIsRelay: false }),
      createCrmRecordFromLead: async (args) => { crmCalls.push(args); return { ok: true, bitrixId: '777' }; },
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.deduped, undefined);
  assert.equal(fakeDb.state.inserted.length, 1);
  assert.equal(fakeDb.state.inserted[0].full_name, 'Bob Lee');
  assert.equal(fakeDb.state.inserted[0].phone, '+14704804679');
  assert.equal(crmCalls.length, 1);
  assert.equal(crmCalls[0].fieldMap.full_name, 'Bob Lee');
  assert.equal(crmCalls[0].fieldMap.phone_number, '+14704804679');
  assert.deepEqual(fakeDb.state.updates[0], { id: 1, bitrixId: '777', status: 'created' });
});

test('ingestIndeedLead: duplicate message id is skipped (no Bitrix call)', async () => {
  const fakeDb = makeFakeDb();
  fakeDb.state.existing.add('indeed:dup1');
  let crmCalled = false;
  const result = await ingestIndeedLead(
    { messageId: 'dup1', subject: 'X applied' },
    {
      db: fakeDb,
      extractResumeContact: async () => ({ phone: null, email: null, emailIsRelay: false }),
      createCrmRecordFromLead: async () => { crmCalled = true; return { ok: true }; },
    }
  );
  assert.equal(result.deduped, true);
  assert.equal(crmCalled, false);
  assert.equal(fakeDb.state.updates.length, 0);
});

test('ingestIndeedLead: missing messageId returns error', async () => {
  const result = await ingestIndeedLead({ subject: 'x' }, { db: makeFakeDb() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_message_id');
});

test('ingestIndeedLead: Bitrix disabled → status disabled, lead still recorded', async () => {
  const fakeDb = makeFakeDb();
  const result = await ingestIndeedLead(
    { messageId: 'm2', subject: 'Ann applied to Driver' },
    {
      db: fakeDb,
      extractResumeContact: async () => ({ phone: null, email: null, emailIsRelay: false }),
      createCrmRecordFromLead: async () => ({ ok: false, reason: 'not_configured' }),
    }
  );
  assert.equal(result.ok, true);
  assert.equal(fakeDb.state.inserted.length, 1);
  assert.equal(fakeDb.state.updates[0].status, 'disabled');
});
