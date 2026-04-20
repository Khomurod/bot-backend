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

function renderCardContent(card) {
  let text = card.narrative_html || '<i>See evidence.</i>';
  text = text.replace(/<\/?ul>/gi, '').replace(/<li>/gi, '• ').replace(/<\/li>/gi, '<br/>');

  const icon = KIND_ICON[card.kind] || '•';
  let title = escapeHtml(card.title || card.kind);
  if (card.driver_name) {
     title = escapeHtml(card.driver_name);
  }

  let evidenceLink = '';
  if (Array.isArray(card.evidence_json) && card.evidence_json.length > 0 && card.evidence_json[0] && card.evidence_json[0].url) {
    evidenceLink = ` (<a href="${card.evidence_json[0].url}">proof</a>)`;
  }

  return `• <b>${title}:</b> ${text}${evidenceLink}`;
}

function renderInsightReportForTelegram({ report, cards, pulse }) {
  const redFlagsKinds = ['at_risk', 'home_time', 'unacked', 'silent', 'anomaly', 'hotspot', 'one_on_one'];
  const redFlags = cards.filter(c => redFlagsKinds.includes(c.kind) || c.severity >= 2);
  const stars = cards.filter(c => c.kind === 'star' || (c.kind !== 'pulse' && !redFlagsKinds.includes(c.kind) && c.severity === 1));

  const generatedDate = report.generated_at ? new Date(report.generated_at).toLocaleDateString() : new Date().toLocaleDateString();

  const pulseSummary = pulse ? `<b>${pulse.active_drivers}</b> active drivers · <b>${pulse.total_messages}</b> messages · avg sentiment <b>${pulse.sentiment_avg}</b> (pos ${pulse.positive_messages} / neg ${pulse.negative_messages})` : 'No data available';

  if (redFlags.length === 0 && stars.length === 0) {
    return [
      '🚛 <b>Weekly Fleet Intelligence Report</b>',
      `📅 <i>Generated: ${generatedDate}</i>`,
      '',
      '📊 <b>Overall Status:</b>',
      pulseSummary,
      '',
      '🚦 <b>The Pulse:</b>',
      `• 💬 <b>Total Messages Analyzed:</b> ${pulse ? pulse.total_messages : 0}`,
      '',
      '✅ All active drivers operated normally with no notable issues.'
    ].join('\n');
  }

  const redFlagsBlock = redFlags.length > 0
    ? `🚨 <b>Actionable Red Flags</b>\n<blockquote expandable>\n${redFlags.map(renderCardContent).join('\n')}\n</blockquote>`
    : '';

  const starsBlock = stars.length > 0
    ? `🌟 <b>Top Performers & Notable Events</b>\n<blockquote expandable>\n${stars.map(renderCardContent).join('\n')}\n</blockquote>`
    : '';

  return [
    '🚛 <b>Weekly Fleet Intelligence Report</b>',
    `📅 <i>Generated: ${generatedDate}</i>`,
    '',
    '📊 <b>Overall Status:</b>',
    pulseSummary,
    '',
    '🚦 <b>The Pulse:</b>',
    `• 🟢 <b>Exceptional Performers:</b> ${stars.length}`,
    `• 🔴 <b>Red Flags Detected:</b> ${redFlags.length}`,
    `• 💬 <b>Total Messages Analyzed:</b> ${pulse ? pulse.total_messages : 0}`,
    '',
    redFlagsBlock,
    '',
    starsBlock
  ].filter(line => line !== null && line !== undefined).join('\n').trim();
}

module.exports = { renderInsightReportForTelegram, renderCard, renderCardContent, escapeHtml, KIND_ICON, KIND_ORDER };
