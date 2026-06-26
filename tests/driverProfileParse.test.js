const test = require('node:test');
const assert = require('node:assert');
const {
  inferDriverType,
  splitName,
  parseDriverFromGroupName,
  stripStatusWords,
  nameMarkedInactive,
  isInactiveGroup,
} = require('../services/driverProfileParse');
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

test('stripStatusWords removes standalone ACTIVE/INACTIVE markers', () => {
  assert.strictEqual(stripStatusWords('GOCHYYEV INACTIVE'), 'GOCHYYEV');
  assert.strictEqual(stripStatusWords('ENNIS INACTIVE'), 'ENNIS');
  assert.strictEqual(stripStatusWords('Active Andersen'), 'Andersen');
  assert.strictEqual(stripStatusWords('Terrell Dalton'), 'Terrell Dalton');
  assert.strictEqual(stripStatusWords(''), '');
});

test('parseDriverFromGroupName drops the INACTIVE marker from the name', () => {
  assert.deepStrictEqual(
    parseDriverFromGroupName('WENZE UNIT # 6810 GOCHY GOCHYYEV INACTIVE'),
    { unit_number: '6810', first_name: 'GOCHY', last_name: 'GOCHYYEV', driver_type: 'owner' }
  );
  assert.deepStrictEqual(
    parseDriverFromGroupName('WENZE UNIT # 4604 EMANUEL ENNIS (COMPANY DRIVER) INACTIVE'),
    { unit_number: '4604', first_name: 'EMANUEL', last_name: 'ENNIS', driver_type: 'company_driver' }
  );
});

test('nameMarkedInactive / isInactiveGroup detect the INACTIVE marker and status', () => {
  assert.strictEqual(nameMarkedInactive('WENZE UNIT # 1 X INACTIVE'), true);
  assert.strictEqual(nameMarkedInactive('WENZE UNIT # 1 X'), false);
  assert.strictEqual(isInactiveGroup({ active: true, group_name: 'WENZE UNIT # 1 X INACTIVE' }), true);
  assert.strictEqual(isInactiveGroup({ active: false, group_name: 'WENZE UNIT # 1 X' }), true);
  assert.strictEqual(isInactiveGroup({ active: true, group_name: 'WENZE UNIT # 1 X', status: 'inactive' }), true);
  assert.strictEqual(isInactiveGroup({ active: true, group_name: 'WENZE UNIT # 1 X', status: 'active' }), false);
});

test('normalizeType (AI value) maps anything containing "company" to company_driver', () => {
  assert.strictEqual(normalizeType('company_driver'), 'company_driver');
  assert.strictEqual(normalizeType('Company Driver'), 'company_driver');
  assert.strictEqual(normalizeType('owner'), 'owner');
  assert.strictEqual(normalizeType(''), 'owner');
});
