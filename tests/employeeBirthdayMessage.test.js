const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBirthdayPrompt,
  parseBirthdayMessageResponse,
  renderFallbackMessage,
} = require('../services/employeeBirthdayMessage');

const employees = [
  { first_name: 'Jane', last_name: 'Doe' },
  { first_name: 'John', last_name: 'Smith' },
];

test('buildBirthdayPrompt includes names and admin instructions', () => {
  const prompt = buildBirthdayPrompt(employees, 'Be cheerful and brief.');
  assert.match(prompt, /Be cheerful and brief/);
  assert.match(prompt, /Jane Doe/);
  assert.match(prompt, /John Smith/);
});

test('parseBirthdayMessageResponse strips markdown fences', () => {
  const text = '```html\n<b>Happy Birthday</b> Jane and John!\n```';
  const parsed = parseBirthdayMessageResponse(text);
  assert.match(parsed, /Happy Birthday/);
  assert.doesNotMatch(parsed, /```/);
});

test('renderFallbackMessage substitutes names placeholder', () => {
  const msg = renderFallbackMessage(employees, 'Hello <b>{names}</b>!');
  assert.equal(msg, 'Hello <b>Jane Doe, John Smith</b>!');
});
