/**
 * The money-code reader.
 *
 * NOBODY HAS SHOWN THIS PARSER A REAL MESSAGE. Every fixture below is invented,
 * so the tests deliberately assert the STATUSES and almost never a specific
 * extracted value from an exotic shape — pinning an extraction this has never
 * seen would be pinning a guess.
 *
 * What is worth guarding is the direction it fails in. A parser that guessed
 * would produce finance records nobody can audit, and the whole feature exists
 * to be auditable. So: two candidates is `ambiguous`, never a pick; a keyword
 * with nothing readable is `unparsed`, never a silent drop; and an ordinary
 * sentence is `not_moneycode`, so normal conversation in the finance group does
 * not land in the finance tables.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PARSER_VERSION, STATUS, KEYWORDS, parseMoneycodeMessage, normaliseCode,
} = require('../lib/finance/moneycode');

test('an ordinary sentence is not a money code', () => {
  for (const text of [
    'good morning everyone',
    'unit 310 is at the shop until Thursday',
    'call me when you get there',
    '',
    null,
    undefined,
  ]) {
    const out = parseMoneycodeMessage(text);
    assert.equal(out.status, STATUS.NOT_MONEYCODE, JSON.stringify(text));
    assert.equal(out.code, null);
    assert.equal(out.amount, null);
  }
});

test('a bare number is not a money code — the keyword is the gate', () => {
  // Truck numbers, phone numbers and load numbers all live in this group.
  const out = parseMoneycodeMessage('1234567890');
  assert.equal(out.status, STATUS.NOT_MONEYCODE);
});

test('a keyword with a single code and a single amount reads cleanly', () => {
  const out = parseMoneycodeMessage('Comchek 1234567890 $500 for unit 310');
  assert.equal(out.status, STATUS.PARSED);
  assert.equal(out.code, '1234567890');
  assert.equal(out.codeNormalized, '1234567890');
  assert.equal(out.amount, 500);
  assert.equal(out.currency, 'USD');
  assert.equal(out.reason, null);
});

test('a code may be grouped by spaces or dashes, and is stored without them', () => {
  for (const text of ['EFS 4567 8901 2345 $250', 'EFS 4567-8901-2345 $250']) {
    const out = parseMoneycodeMessage(text);
    assert.equal(out.status, STATUS.PARSED, text);
    assert.equal(out.code, '456789012345', text);
  }
});

test('an amount is never mistaken for the code', () => {
  const out = parseMoneycodeMessage('money code 1234567890 $500');
  assert.equal(out.status, STATUS.PARSED);
  assert.equal(out.code, '1234567890');
  assert.equal(out.amount, 500);
});

test('a thousands separator and cents survive', () => {
  const out = parseMoneycodeMessage('Comchek 1234567890 $1,250.75');
  assert.equal(out.status, STATUS.PARSED);
  assert.equal(out.amount, 1250.75);
});

test('a code with no amount still reads — the amount is optional, the code is not', () => {
  const out = parseMoneycodeMessage('money code 1234567890 sent');
  assert.equal(out.status, STATUS.PARSED);
  assert.equal(out.code, '1234567890');
  assert.equal(out.amount, null);
});

test('two codes is ambiguous, and it does NOT pick one', () => {
  const out = parseMoneycodeMessage('EFS 4567890123 and 9876543210 $250');
  assert.equal(out.status, STATUS.AMBIGUOUS);
  assert.equal(out.code, null);
  assert.equal(out.amount, null);
  assert.deepEqual(out.codes, ['4567890123', '9876543210']);
  assert.match(out.reason, /2 candidate codes/);
});

test('two amounts is ambiguous, and it does NOT pick one', () => {
  const out = parseMoneycodeMessage('moneycode 1234567890 $250 or $300');
  assert.equal(out.status, STATUS.AMBIGUOUS);
  assert.equal(out.amount, null);
  assert.deepEqual(out.amounts, [250, 300]);
  assert.match(out.reason, /2 candidate amounts/);
});

test('an ambiguous row carries what the machine saw, so a person need not re-read the message', () => {
  const out = parseMoneycodeMessage('EFS 4567890123 and 9876543210 $250');
  assert.equal(out.codes.length, 2);
  assert.deepEqual(out.amounts, [250]);
});

test('the same code twice is one candidate, not two', () => {
  // A quoted or repeated code is one code. Reading it as ambiguous would send
  // a perfectly clear message to a human for no reason.
  const out = parseMoneycodeMessage('money code 1234567890 — again, 1234567890 $500');
  assert.equal(out.status, STATUS.PARSED);
  assert.equal(out.code, '1234567890');
});

test('a keyword with nothing readable is unparsed, never dropped', () => {
  for (const text of ['money code please', 'need a fuel advance', 'Comchek coming shortly']) {
    const out = parseMoneycodeMessage(text);
    assert.equal(out.status, STATUS.UNPARSED, text);
    assert.match(out.reason, /no code/);
  }
});

test('a number too short or too long to be a code does not make one', () => {
  assert.equal(parseMoneycodeMessage('money code 12345').status, STATUS.UNPARSED);
  assert.equal(parseMoneycodeMessage('money code 12345678901234567').status, STATUS.UNPARSED);
});

test('every keyword actually opens the gate', () => {
  for (const word of KEYWORDS) {
    const out = parseMoneycodeMessage(`${word} 1234567890 $100`);
    assert.notEqual(out.status, STATUS.NOT_MONEYCODE, word);
  }
});

test('the gate is case-insensitive', () => {
  assert.equal(parseMoneycodeMessage('COMCHEK 1234567890 $100').status, STATUS.PARSED);
  assert.equal(parseMoneycodeMessage('MoneyCode 1234567890 $100').status, STATUS.PARSED);
});

test('every result carries the parser version that produced it', () => {
  // Stored on the row so a tightened parser can re-read exactly the rows the
  // old one produced, rather than leaving two vocabularies mixed in the table.
  for (const text of ['hello', 'money code please', 'Comchek 1234567890 $500']) {
    assert.equal(parseMoneycodeMessage(text).parserVersion, PARSER_VERSION);
  }
});

test('normaliseCode strips only the grouping, and tolerates nothing', () => {
  assert.equal(normaliseCode('4567 8901 2345'), '456789012345');
  assert.equal(normaliseCode('4567-8901'), '45678901');
  assert.equal(normaliseCode(null), '');
  assert.equal(normaliseCode(undefined), '');
});

test('it never throws, whatever it is handed', () => {
  for (const junk of [null, undefined, 0, 42, {}, [], true, NaN]) {
    assert.doesNotThrow(() => parseMoneycodeMessage(junk));
  }
});
