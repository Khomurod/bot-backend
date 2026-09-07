/**
 * The HTML the /ringcentral/connect flow serves — pure rendering, no I/O.
 *
 * A recruiter opens these on a phone, from a link someone sent them, so the
 * markup is self-contained: one inline stylesheet, no external assets, nothing
 * that needs the admin bundle. Same visual language as the Facebook connect
 * pages so the two self-serve flows feel like one product.
 *
 * Every interpolated value goes through escapeHtml(): names come from
 * RingCentral, and error text can carry anything an API returned.
 */

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCardPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f3f0e8;
      --ink: #152033;
      --muted: #5d6675;
      --card: rgba(255, 255, 255, 0.86);
      --line: rgba(21, 32, 51, 0.12);
      --primary: #0f766e;
      --primary-ink: #ffffff;
      --warn: #b45309;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.18), transparent 35%),
        radial-gradient(circle at bottom right, rgba(217, 119, 6, 0.16), transparent 30%),
        linear-gradient(160deg, #fbf8f0 0%, var(--bg) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: min(640px, 100%);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 24px;
      padding: 28px;
      box-shadow: 0 24px 60px rgba(21, 32, 51, 0.14);
    }
    h1 { margin: 0 0 10px; font-size: clamp(26px, 4vw, 38px); line-height: 1.1; }
    p, li, dt, dd {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--muted);
      line-height: 1.55;
      font-size: 16px;
    }
    .button {
      display: inline-block;
      margin-top: 18px;
      padding: 14px 22px;
      border-radius: 999px;
      background: var(--primary);
      color: var(--primary-ink);
      text-decoration: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 17px;
      font-weight: 600;
    }
    .facts { margin: 18px 0 0; padding: 0; }
    .facts div { display: flex; gap: 10px; padding: 7px 0; border-top: 1px solid var(--line); }
    .facts dt { margin: 0; min-width: 150px; font-weight: 600; color: var(--ink); }
    .facts dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .note { margin-top: 18px; padding: 12px 14px; border-radius: 12px; background: rgba(180, 83, 9, 0.1); }
    .note p { color: var(--warn); margin: 0; }
    ol { padding-left: 22px; }
  </style>
</head>
<body>
  <div class="card">
${bodyHtml}
  </div>
</body>
</html>`;
}

/** The landing page: what is about to happen, and one button. */
function renderConnectLandingPage({ session, recruiter, startUrl }) {
  const who = recruiter?.name || session?.invited_name || '';
  const greeting = who ? `Connect RingCentral, ${escapeHtml(who)}` : 'Connect Your RingCentral Number';
  const numberLine = recruiter?.phone_number
    ? `<p>This will attach the RingCentral account that owns <strong>${escapeHtml(recruiter.phone_number)}</strong>.</p>`
    : '<p>The number your texts go out from is read from your RingCentral account — you do not have to type it.</p>';

  return renderCardPage('Connect RingCentral', `    <h1>${greeting}</h1>
    ${numberLine}
    <p>Once connected, every Facebook lead assigned to you in Bitrix24 is texted
    from <strong>your</strong> number, and the driver's reply comes back to you.</p>
    <ol>
      <li>Press the button below.</li>
      <li>Sign in to RingCentral as yourself.</li>
      <li>Approve the access request. That is it — nothing to copy or paste.</li>
    </ol>
    <a class="button" href="${escapeHtml(startUrl)}">Sign in with RingCentral</a>
    <p style="margin-top:18px;font-size:14px;">This link is personal and expires in 30 minutes.</p>`);
}

/** The result page — success, with what was attached, or a plain error. */
function renderConnectResultPage({ title, message, facts = [], warning = null }) {
  const factRows = facts
    .filter((fact) => fact && fact.value)
    .map((fact) => `      <div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd></div>`)
    .join('\n');

  return renderCardPage(title, `    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
${factRows ? `    <dl class="facts">\n${factRows}\n    </dl>` : ''}
${warning ? `    <div class="note"><p>${escapeHtml(warning)}</p></div>` : ''}`);
}

module.exports = {
  escapeHtml,
  renderCardPage,
  renderConnectLandingPage,
  renderConnectResultPage,
};
