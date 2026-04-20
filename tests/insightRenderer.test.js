const test = require('node:test');
const assert = require('node:assert/strict');

const { renderInsightReportForTelegram, escapeHtml, KIND_ORDER } = require('../services/insightRenderer');

test('escapeHtml escapes entities', () => {
  assert.equal(escapeHtml('<b>"hi"</b> & go'), '&lt;b&gt;"hi"&lt;/b&gt; &amp; go');
});

test('renderInsightReportForTelegram orders cards by KIND_ORDER', () => {
  const report = { id: 1, generated_at: new Date('2026-04-20T12:00:00Z').toISOString() };
  const pulse = { days_back: 7, total_messages: 10, active_drivers: 3, sentiment_avg: 0, positive_messages: 2, negative_messages: 1 };
  const cards = [
    { id: 1, kind: 'at_risk', title: 'At-risk: John', narrative_html: 'text1', severity: 3 },
    { id: 2, kind: 'pulse', title: 'Pulse', narrative_html: 'p', severity: 1 },
    { id: 3, kind: 'star', title: 'Star: Jane', narrative_html: 'text2', severity: 1 },
  ];
  const html = renderInsightReportForTelegram({ report, cards, pulse });
  // Pulse header block appears before at_risk, before star (per KIND_ORDER)
  assert.ok(html.indexOf('Pulse') < html.indexOf('At-risk: John'));
  assert.ok(html.indexOf('At-risk: John') < html.indexOf('Star: Jane'));
  assert.match(html, /Company AI Weekly Briefing/);
});

test('KIND_ORDER contains expected kinds', () => {
  for (const k of ['pulse', 'at_risk', 'home_time', 'unacked', 'silent', 'anomaly', 'hotspot', 'star', 'one_on_one']) {
    assert.ok(KIND_ORDER.includes(k), `missing kind: ${k}`);
  }
});
