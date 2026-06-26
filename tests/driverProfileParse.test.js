const test = require('node:test');
const assert = require('node:assert');
const { inferDriverType, splitName, parseDriverFromGroupName } = require('../services/driverProfileParse');
const { normalizeType } = require('../services/driverProfileAiParser');

test('inferDriverType: company driver only when the name marks it', () => {
  assert.strictEqual(inferDriverType('WENZE UNIT # 2614 TERRELL DALTON (COMPANY DRIVER)'), 'company_driver');
  assert.strictEqual(inferDriverType('WENZE UNIT # 008 ABDINASIR / IBRAHIM (COMPANY DRIVERS)'), 'company_driver');
  assert.strictEqual(inferDriverType('WENZE UNIT # 310 JAKHONGIR ABDUNABIEV'), 'owner');
  assert.strictEqual(inferDriverType(''), 'owner');
  assert.strictEqual(inferDriverType(null), 'owner');
});

test('splitName handles 0/1/many tokens', () => {
  assert.deepStrictEqual(splitName(''), { first_name: null, last_name: null });
  assert.deepStrictEqual(splitName('Madonna'), { first_name: 'Madonna', last_name: null });
  assert.deepStrictEqual(splitName('Terrell Dalton'), { first_name: 'Terrell', last_name: 'Dalton' });
  assert.deepStrictEqual(splitName('Mary Jane Watson'), { first_name: 'Mary', last_name: 'Jane Watson' });
});

test('parseDriverFromGroupName extracts unit, name, and type', () => {
  assert.deepStrictEqual(
    parseDriverFromGroupName('WENZE UNIT # 310 JAKHONGIR ABDUNABIEV'),
    { unit_number: '310', first_name: 'JAKHONGIR', last_name: 'ABDUNABIEV', driver_type: 'owner' }
  );
  assert.deepStrictEqual(
    parseDriverFromGroupName('WENZE UNIT # 2614 TERRELL DALTON (COMPANY DRIVER)'),
    { unit_number: '2614', first_name: 'TERRELL', last_name: 'DALTON', driver_type: 'company_driver' }
  );
});

test('normalizeType (AI value) maps anything containing "company" to company_driver', () => {
  assert.strictEqual(normalizeType('company_driver'), 'company_driver');
  assert.strictEqual(normalizeType('Company Driver'), 'company_driver');
  assert.strictEqual(normalizeType('owner'), 'owner');
  assert.strictEqual(normalizeType(''), 'owner');
});
