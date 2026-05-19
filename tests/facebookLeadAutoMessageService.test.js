const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const {
  pickActiveRule,
  resolveTemplateAt,
  previewAutoMessage,
  previewTemplate,
  isTimeInWindow,
  timeToMinutes,
} = require('../services/facebookLeadAutoMessageService');

const settings = {
  timezone: 'America/Chicago',
  fallback_template: 'Fallback for {first_name}',
};

const rules = [
  {
    id: 1,
    label: 'Working hours',
    days_of_week: [1, 2, 3, 4, 5],
    start_time_local: '08:00',
    end_time_local: '17:00',
    message_template: 'Call now {first_name}',
    sort_order: 0,
    is_active: true,
  },
  {
    id: 2,
    label: 'Weekend',
    days_of_week: [6, 7],
    start_time_local: '09:00',
    end_time_local: '14:00',
    message_template: 'Weekend {first_name}',
    sort_order: 1,
    is_active: true,
  },
];

test('isTimeInWindow handles same-day and overnight ranges', () => {
  assert.equal(isTimeInWindow(timeToMinutes('10:00'), timeToMinutes('08:00'), timeToMinutes('17:00')), true);
  assert.equal(isTimeInWindow(timeToMinutes('07:00'), timeToMinutes('08:00'), timeToMinutes('17:00')), false);
  assert.equal(isTimeInWindow(timeToMinutes('23:00'), timeToMinutes('22:00'), timeToMinutes('06:00')), true);
  assert.equal(isTimeInWindow(timeToMinutes('12:00'), timeToMinutes('22:00'), timeToMinutes('06:00')), false);
});

test('pickActiveRule matches weekday working hours', () => {
  const wed10am = DateTime.fromISO('2026-05-20T10:00:00', { zone: 'America/Chicago' });
  const rule = pickActiveRule(rules, wed10am);
  assert.equal(rule.label, 'Working hours');
});

test('pickActiveRule uses fallback outside hours', () => {
  const wed7pm = DateTime.fromISO('2026-05-20T19:00:00', { zone: 'America/Chicago' });
  const picked = resolveTemplateAt({ settings, rules, at: wed7pm.toISO() });
  assert.equal(picked.source, 'fallback');
  assert.equal(picked.template, settings.fallback_template);
});

test('pickActiveRule respects sort_order', () => {
  const sat10am = DateTime.fromISO('2026-05-23T10:00:00', { zone: 'America/Chicago' });
  const rule = pickActiveRule(rules, sat10am);
  assert.equal(rule.label, 'Weekend');
});

test('previewAutoMessage with explicit template renders that text', () => {
  const result = previewAutoMessage({
    settings,
    rules,
    template: 'Hi {first_name}, call me back when you can.',
    fieldMap: { full_name: 'Jane Doe' },
    ruleLabel: 'Fallback (outside hours)',
  });
  assert.equal(result.source, 'template');
  assert.equal(result.ruleLabel, 'Fallback (outside hours)');
  assert.match(result.rendered, /Hi Jane, call me back/);
});

test('previewAutoMessage at Saturday evening uses fallback not weekday rule', () => {
  const sat8pm = DateTime.fromISO('2026-05-23T20:00:00', { zone: 'America/Chicago' }).toISO();
  const result = previewAutoMessage({
    settings,
    rules,
    fieldMap: { full_name: 'Jane Doe' },
    at: sat8pm,
  });
  assert.equal(result.source, 'fallback');
  assert.match(result.rendered, /Fallback for Jane/);
  assert.equal(result.timezone, 'America/Chicago');
  assert.ok(result.evaluated_at_iso);
});

test('previewTemplate helper renders without time routing', () => {
  const result = previewTemplate({
    settings,
    template: 'Custom {first_name} from {company_name}',
    fieldMap: { full_name: 'Bob Smith' },
    ruleLabel: 'My rule',
  });
  assert.match(result.rendered, /Custom Bob/);
  assert.equal(result.ruleLabel, 'My rule');
});
