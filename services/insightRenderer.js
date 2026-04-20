// services/insightRenderer.js
//
// Renders an insight report (report envelope + cards) into Telegram-safe HTML.

const KIND_ICON = {
  pulse: '📊',
  at_risk: '🚨',
  star: '⭐',
  home_time: '🏠',
  unacked: '⏳',
  silent: '🤐',
  anomaly: '📈',
  hotspot: '🔥',
  one_on_one: '🗣️',
};

const KIND_ORDER = ['pulse', 'at_risk', 'home_time', 'unacked', 'silent', 'anomaly', 'hotspot', 'star', 'one_on_one'];

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function evidenceBlock(evidenceArr) {
  if (!Array.isArray(evidenceArr) || !evidenceArr.length) return '';
  const lines = evidenceArr.slice(0, 5).map((e) => {
    if (!e) return '';
    const excerpt = escapeHtml(e.excerpt || e.text || '');
    if (e.url) {
      return `• <a href="${e.url}">proof</a> — ${excerpt}`;
    }
    return `• ${excerpt}`;
  }).filter(Boolean);
  if (!lines.length) return '';
  return `<blockquote expandable>${lines.join('<br/>')}</blockquote>`;
}

function renderCard(card) {
  const icon = KIND_ICON[card.kind] || '•';
  const title = escapeHtml(card.title || card.kind);
  const body = card.narrative_html || '<i>No narrative.</i>';
  const action = card.suggested_action
    ? `<br/><i>Action:</i> ${escapeHtml(card.suggested_action)}`
    : '';
  const evidence = evidenceBlock(card.evidence_json);
  return [
    `<b>${icon} ${title}</b>`,
    body,
    action,
    evidence,
  ].filter(Boolean).join('\n');
}

function renderInsightReportForTelegram({ report, cards, pulse }) {
  const sortedCards = [...cards].sort((a, b) => {
    const ai = KIND_ORDER.indexOf(a.kind);
    const bi = KIND_ORDER.indexOf(b.kind);
    if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return (b.severity || 0) - (a.severity || 0);
  });
  const header = [
    '📢 <b>Company AI Weekly Briefing</b>',
    `<i>Window:</i> last ${pulse?.days_back || 7} days`,
    `<i>Generated:</i> ${escapeHtml(new Date(report.generated_at || Date.now()).toLocaleString())}`,
  ].join('\n');
  const body = sortedCards.map(renderCard).join('\n\n━━━━━━━━━━━━━━━━━\n\n');
  return `${header}\n\n${body}`;
}

module.exports = { renderInsightReportForTelegram, renderCard, escapeHtml, KIND_ICON, KIND_ORDER };
