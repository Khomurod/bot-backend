'use strict';

/**
 * Capturing what the finance group says.
 *
 * THE GATE IS THE THING. A payment reader that captures from the wrong chat is
 * worse than one that captures nothing, so most of this file is about messages
 * it must NOT touch — and about telling "not our chat" apart from "something
 * broke", which look identical from the outside and mean opposite things.
 *
 * The database is stubbed here on purpose. What is under test is the decision
 * flow: which messages are stored, which produce a money-code row, and what
 * happens when a read fails. The SQL has its own *Pg tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SETTINGS = path.resolve(__dirname, '../database/financeSettings.js');
const MESSAGES = path.resolve(__dirname, '../database/financeMessages.js');
const SERVICE = path.resolve(__dirname, '../services/finance/captureService.js');

/** Load the service with the two data modules replaced. */
function load({ onWatch = true, settings = {}, messages = {}, settingsThrows = null } = {}) {
  for (const p of [SETTINGS, MESSAGES, SERVICE]) delete require.cache[p];

  const calls = { captured: [], codes: [], edits: [], candidates: [], refreshed: [], reparsed: [] };

  require.cache[SETTINGS] = {
    exports: {
      isFinanceChat: async () => {
        if (settingsThrows) throw settingsThrows;
        return onWatch;
      },
      getFinanceSettings: async () => ({ duplicateWindowHours: 72, ...settings }),
    },
  };
  require.cache[MESSAGES] = {
    exports: {
      captureMessage: async (m, parsed) => {
        calls.captured.push({ m, parsed });
        return messages.captureMessage
          ? messages.captureMessage(m, parsed)
          : { id: 1, created: true };
      },
      applyEdit: async (chatId, messageId, text, parsed) => {
        calls.edits.push({ chatId, messageId, text, parsed });
        return messages.applyEdit ? messages.applyEdit() : 1;
      },
      recordMoneycode: async (refId, fields) => {
        calls.codes.push({ refId, fields });
        return messages.recordMoneycode ? messages.recordMoneycode(refId, fields) : 10;
      },
      updateMoneycodeInterpretation: async (refId, codeNormalized, fields) => {
        calls.refreshed.push({ refId, codeNormalized, fields });
        return 11;
      },
      reparseMessage: async (id) => {
        calls.reparsed.push(id);
        return messages.reparseMessage ? messages.reparseMessage(id) : null;
      },
      findDuplicateCandidates: async (q) => {
        calls.candidates.push(q);
        return messages.findDuplicateCandidates ? messages.findDuplicateCandidates(q) : [];
      },
    },
  };

  return { service: require(SERVICE), calls };
}

function msg(overrides = {}) {
  return {
    chat: { id: -1001 },
    message_id: 55,
    from: { id: 777, username: 'ivan', first_name: 'Ivan', last_name: 'P' },
    text: 'Comchek 1234567890 $500',
    date: Math.floor(Date.parse('2026-09-12T10:00:00Z') / 1000),
    ...overrides,
  };
}

test('a message from another chat leaves no trace at all', async () => {
  const { service, calls } = load({ onWatch: false });
  const out = await service.captureFinanceMessage(msg());
  assert.equal(out.handled, false);
  assert.equal(out.reason, 'not the finance chat');
  assert.equal(calls.captured.length, 0, 'nothing stored');
  assert.equal(calls.codes.length, 0);
});

test('a settings read that FAILS is not reported as "not the finance chat"', async () => {
  // The two look identical from outside and mean opposite things: one is a
  // message that is none of our business, the other is capture silently
  // stopping. Collapsing them is how a payment log quietly goes empty.
  const { service, calls } = load({ settingsThrows: Object.assign(new Error('boom'), { code: '53300' }) });
  const out = await service.captureFinanceMessage(msg());
  assert.equal(out.handled, false);
  assert.equal(out.reason, 'settings unavailable');
  assert.notEqual(out.reason, 'not the finance chat');
  assert.equal(calls.captured.length, 0);
});

test('a message with no chat is refused before anything is read', async () => {
  const { service, calls } = load();
  const out = await service.captureFinanceMessage({ message_id: 1 });
  assert.equal(out.handled, false);
  assert.equal(out.reason, 'no chat');
  assert.equal(calls.candidates.length, 0);
});

test('a readable money code is captured AND recorded', async () => {
  const { service, calls } = load();
  const out = await service.captureFinanceMessage(msg());
  assert.equal(out.handled, true);
  assert.equal(out.status, 'parsed');
  assert.equal(calls.captured.length, 1);
  assert.equal(calls.codes.length, 1);
  assert.equal(calls.codes[0].fields.codeNormalized, '1234567890');
  assert.equal(calls.codes[0].fields.amount, 500);
});

test('an ambiguous message is captured but produces NO money-code row', async () => {
  // Inventing a row from a message the parser could not read is the guess this
  // whole feature refuses. The text is kept for a person instead.
  const { service, calls } = load();
  const out = await service.captureFinanceMessage(msg({ text: 'EFS 4567890123 and 9876543210 $250' }));
  assert.equal(out.handled, true);
  assert.equal(out.status, 'ambiguous');
  assert.equal(calls.captured.length, 1);
  assert.equal(calls.codes.length, 0);
});

test('ordinary chat in the finance group is stored and classified, not ignored', async () => {
  const { service, calls } = load();
  const out = await service.captureFinanceMessage(msg({ text: 'morning all' }));
  assert.equal(out.handled, true);
  assert.equal(out.status, 'not_moneycode');
  assert.equal(calls.captured.length, 1, 'the record is the whole group, not just the money');
  assert.equal(calls.codes.length, 0);
});

test('a redelivery is a no-op, not a second row', async () => {
  const { service, calls } = load({
    messages: { captureMessage: () => ({ id: 1, created: false }) },
  });
  const out = await service.captureFinanceMessage(msg());
  assert.equal(out.handled, true);
  assert.equal(out.reason, 'already captured');
  assert.equal(calls.codes.length, 0, 'and no second money-code row either');
});

test('a repeated code is recorded as a duplicate, and nothing is blocked', async () => {
  const { service, calls } = load({
    messages: {
      findDuplicateCandidates: () => ([
        { id: 9, codeNormalized: '1234567890', amount: 500, issuedAt: '2026-09-11T10:00:00Z' },
      ]),
    },
  });
  const out = await service.captureFinanceMessage(msg());
  assert.equal(out.handled, true);
  assert.equal(calls.codes.length, 1, 'still recorded — Wenze cannot recall a code');
  assert.equal(calls.codes[0].fields.duplicateOfId, 9);
  assert.equal(calls.codes[0].fields.duplicateReason, 'same_code');
});

test('the duplicate search window comes from settings, not from a constant here', async () => {
  const { service, calls } = load({ settings: { duplicateWindowHours: 24 } });
  await service.captureFinanceMessage(msg());
  const since = calls.candidates[0].since;
  const issued = Date.parse('2026-09-12T10:00:00Z');
  assert.equal(issued - since.getTime(), 24 * 3600 * 1000);
});

test('issued_to is left empty rather than filled with the SENDER', async () => {
  // Who posted a code is not who it was for, and a column of wrong values
  // under an "issued to" heading is worse than an empty one.
  const { service, calls } = load();
  await service.captureFinanceMessage(msg());
  assert.equal(calls.codes[0].fields.issuedTo, null);
  assert.equal(calls.codes[0].fields.issuedToNormalized, null);
  assert.equal(calls.codes[0].fields.senderName, 'Ivan P', 'the sender IS recorded, as the sender');
});

test('an edit re-reads the message and does not create a second row', async () => {
  const { service, calls } = load();
  const out = await service.captureFinanceMessage(msg({ text: 'Comchek 1234567890 $600' }), { isEdit: true });
  assert.equal(out.handled, true);
  assert.equal(out.reason, 'edited');
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.captured.length, 0);
});

test('an edit of a message never captured is refused, not invented', async () => {
  const { service } = load({ messages: { applyEdit: () => null } });
  const out = await service.captureFinanceMessage(msg(), { isEdit: true });
  assert.equal(out.handled, false);
  assert.match(out.reason, /never captured/);
});

test('a capture failure is contained — it never throws at the bot', async () => {
  // This sits in Telegram's message pipeline. A throw here would stop
  // everything downstream from seeing the message.
  const { service } = load({
    messages: { captureMessage: () => { throw new Error('write failed'); } },
  });
  let out;
  await assert.doesNotReject(async () => { out = await service.captureFinanceMessage(msg()); });
  assert.equal(out.handled, false);
  assert.equal(out.reason, 'capture failed');
});

test('shapeMessage takes a caption when there is no text, and flags the media', async () => {
  const { service } = load();
  const shaped = service.shapeMessage(msg({
    text: undefined, caption: 'Comchek 1234567890', document: { file_id: 'abc' },
  }));
  assert.equal(shaped.text, 'Comchek 1234567890');
  assert.equal(shaped.hasDocument, true);
  assert.equal(shaped.hasPhoto, false);
});

test('shapeMessage turns Telegram seconds into a real date, and nothing into null', async () => {
  const { service } = load();
  assert.equal(service.shapeMessage(msg()).messageDate.toISOString(), '2026-09-12T10:00:00.000Z');
  assert.equal(service.shapeMessage(msg({ date: undefined })).messageDate, null);
  assert.equal(service.shapeMessage(msg({ date: 0 })).messageDate, null);
});

// ── re-reading a stored message ───────────────────────────────────────────

/**
 * THE WHOLE POINT OF KEEPING THE TEXT.
 *
 * A re-read that only updated `parse_status` moved the message off the unclear
 * pile, told the operator it had worked, and left the Money codes tab and every
 * weekly total still missing the code it had just recognised. The code has to
 * land, through the same duplicate decision a live capture uses.
 */
test('a re-read that finds a code RECORDS it', async () => {
  const { service, calls } = load({
    messages: {
      reparseMessage: () => ({
        id: 42, before: 'unparsed', after: 'parsed',
        parsed: {
          status: 'parsed', code: '1234567890', codeNormalized: '1234567890',
          amount: 500, currency: 'USD', parserVersion: 1,
        },
        senderUserId: 777, senderName: 'Ivan P',
        messageDate: new Date('2026-09-12T10:00:00Z'),
      }),
    },
  });

  const out = await service.reparseCapturedMessage(42);

  assert.equal(out.after, 'parsed');
  assert.equal(out.codeRecorded, true);
  assert.equal(calls.codes.length, 1, 'the code must reach finance_moneycodes');
  assert.equal(calls.codes[0].refId, 42);
  assert.equal(calls.codes[0].fields.codeNormalized, '1234567890');
  assert.equal(calls.codes[0].fields.senderName, 'Ivan P', 'the stored sender, not a blank');
  assert.equal(calls.candidates.length, 1, 'and through the duplicate decision');
});

/** A re-read that still cannot read it writes no code, and says so. */
test('a re-read that is still unclear records nothing', async () => {
  const { service, calls } = load({
    messages: {
      reparseMessage: () => ({
        id: 42, before: 'unparsed', after: 'ambiguous',
        parsed: { status: 'ambiguous' }, senderUserId: null, senderName: null, messageDate: null,
      }),
    },
  });

  const out = await service.reparseCapturedMessage(42);
  assert.equal(out.codeRecorded, false);
  assert.deepEqual(calls.codes, []);
});

/**
 * A tightened parser reaching a DIFFERENT amount for a code already recorded
 * must not leave the old one beside the corrected reading.
 */
test('a re-read that reinterprets an existing code refreshes it', async () => {
  const { service, calls } = load({
    messages: {
      // The row is already there, so the idempotent insert is a no-op.
      recordMoneycode: () => null,
      reparseMessage: () => ({
        id: 42, before: 'parsed', after: 'parsed',
        parsed: {
          status: 'parsed', code: '1234567890', codeNormalized: '1234567890',
          amount: 750, currency: 'USD', parserVersion: 2,
        },
        senderUserId: 777, senderName: 'Ivan P',
        messageDate: new Date('2026-09-12T10:00:00Z'),
      }),
    },
  });

  const out = await service.reparseCapturedMessage(42);

  assert.equal(out.codeRecorded, true);
  assert.equal(calls.refreshed.length, 1, 'the stored amount must follow the fresher reading');
  assert.equal(calls.refreshed[0].fields.amount, 750);
  assert.equal(calls.refreshed[0].fields.parserVersion, 2);
});

/** No such message is null, not a pretend success. */
test('re-reading a message that is not there returns null', async () => {
  const { service } = load({ messages: { reparseMessage: () => null } });
  assert.equal(await service.reparseCapturedMessage(9999), null);
});
