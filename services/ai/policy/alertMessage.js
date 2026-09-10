/**
 * What the Telegram alert actually says. PURE.
 *
 * An alert that says "the terms changed, check the admin" is a notification, not
 * information — it costs a person a context switch to learn whether they need
 * to care. So the message carries the four things that let somebody decide
 * without opening anything: **what changed, why it matters, the provider's own
 * words, and the official URL.**
 *
 * The quoted passage is the part people trust. A claim about a provider's terms
 * that cannot be checked against the provider's page is a claim nobody should
 * act on, and this feature can suspend a provider — so it had better show its
 * evidence.
 */

const SEVERITY_MARK = { info: 'ℹ️', warning: '⚠️', serious: '🚨' };

const CATEGORY_LABEL = {
  commercial_use: 'Commercial / production use',
  trains_on_data: 'Training on submitted data',
  free_tier: 'Free-tier limits',
  retention: 'Data retention',
  discontinuation: 'Deprecation or shutdown',
  geography: 'Geographic availability',
  other: 'Other terms',
};

/** Telegram rejects an over-long message outright; trim before it can. */
const MAX_QUOTE = 700;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {object} [options.deterministic]  the finding was produced by a rule
 *   with no model involved and none wanted — a retired model, a lost source —
 *   so the "no AI provider was available to summarise" line would be untrue.
 */
function buildAlertBody(finding, { suspension = null, deterministic = false } = {}) {
  const mark = SEVERITY_MARK[finding.severity] || 'ℹ️';
  const category = CATEGORY_LABEL[finding.category] || CATEGORY_LABEL.other;
  const lines = [
    `${mark} <b>${escapeHtml(finding.providerKey)} — ${escapeHtml(category)}</b>`,
    '',
    escapeHtml(finding.summary),
  ];

  if (finding.whatChanged) lines.push('', `<b>What changed:</b> ${escapeHtml(finding.whatChanged)}`);
  if (finding.whyItMatters) lines.push('', `<b>Why it matters:</b> ${escapeHtml(finding.whyItMatters)}`);

  if (finding.quotedPassage) {
    const quote = finding.quotedPassage.length > MAX_QUOTE
      ? `${finding.quotedPassage.slice(0, MAX_QUOTE)}…`
      : finding.quotedPassage;
    lines.push('', '<b>Their words:</b>', `<pre>${escapeHtml(quote)}</pre>`);
  }

  if (finding.suspendedProvider) {
    lines.push(
      '',
      `🛑 <b>${escapeHtml(finding.providerKey)} has been paused</b> — it is not being asked for `
      + 'anything until someone reviews this. AI features fall back to their deterministic '
      + 'logic in the meantime.',
      `Rule: <code>${escapeHtml(finding.suspensionRule)}</code>`,
      'Clear it in Admin → Settings → AI.'
    );
  } else if (suspension?.rule) {
    // The rule matched but the operator has automatic suspension turned off.
    // Say so plainly rather than letting the silence imply nothing matched.
    lines.push(
      '',
      `A suspension rule matched (<code>${escapeHtml(suspension.rule)}</code>) but automatic `
      + 'suspension is turned off, so nothing was paused.'
    );
  }

  if (!finding.aiAssisted && !deterministic) {
    lines.push(
      '',
      '<i>No AI provider was available to summarise this, so the change is reported '
      + 'from the raw difference above.</i>'
    );
  }

  lines.push('', `<a href="${escapeHtml(finding.sourceUrl)}">Read the official page</a>`);
  return lines.join('\n');
}

module.exports = { buildAlertBody, SEVERITY_MARK, CATEGORY_LABEL, MAX_QUOTE, escapeHtml };
