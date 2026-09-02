/**
 * The HTML the /facebook/connect flow serves — pure rendering, no I/O.
 *
 * A recruiter opens these pages in a phone browser after the bot DMs them a
 * /connect link, so the markup is self-contained: one inline stylesheet, no
 * external assets, and nothing that needs the admin bundle to load.
 *
 * Split out of server/routes/facebookConnectRoutes.js. Every value that
 * reaches the markup goes through escapeHtml() — page names and error text
 * come from Meta and from user input.
 */

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFacebookCardPage(title, bodyHtml) {
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
        --card: rgba(255, 255, 255, 0.84);
        --line: rgba(21, 32, 51, 0.12);
        --primary: #0f766e;
        --primary-ink: #ffffff;
        --accent: #d97706;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(217, 119, 6, 0.18), transparent 35%),
          radial-gradient(circle at bottom right, rgba(15, 118, 110, 0.18), transparent 30%),
          linear-gradient(160deg, #fbf8f0 0%, var(--bg) 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: min(760px, 100%);
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 24px 60px rgba(21, 32, 51, 0.14);
        backdrop-filter: blur(8px);
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(30px, 4vw, 42px);
        line-height: 1.05;
      }
      p, li, label {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--muted);
        line-height: 1.55;
        font-size: 16px;
      }
      .group {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 18px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.1);
        color: var(--primary);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-weight: 600;
      }
      .button, button {
        appearance: none;
        border: none;
        border-radius: 999px;
        padding: 14px 22px;
        background: var(--primary);
        color: var(--primary-ink);
        text-decoration: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
      }
      .button.secondary {
        background: transparent;
        color: var(--primary);
        border: 1px solid rgba(15, 118, 110, 0.26);
      }
      .stack {
        display: grid;
        gap: 16px;
      }
      .pages {
        display: grid;
        gap: 12px;
        margin: 20px 0;
      }
      .page {
        display: grid;
        gap: 6px;
        padding: 16px 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.8);
      }
      .page strong {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ink);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 20px;
      }
      .note {
        margin-top: 14px;
        padding: 14px 16px;
        border-left: 4px solid var(--accent);
        background: rgba(217, 119, 6, 0.08);
      }
      input[type="checkbox"] {
        inline-size: 18px;
        block-size: 18px;
        accent-color: var(--primary);
      }
      .checkbox-row {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .pill {
        display: inline-block;
        margin-right: 8px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(21, 32, 51, 0.06);
        font-size: 12px;
        color: var(--ink);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      @media (max-width: 640px) {
        .card { padding: 22px; }
        .actions { flex-direction: column; }
        .button, button { width: 100%; text-align: center; }
      }
    </style>
  </head>
  <body>
    <div class="card">
      ${bodyHtml}
    </div>
  </body>
  </html>`;
}

function renderConnectLandingPage(session) {
  return renderFacebookCardPage(
    'Connect Facebook',
    `
      <div class="group">Telegram Group: ${escapeHtml(session.group_name || String(session.telegram_group_id))}</div>
      <h1>Connect Facebook Pages</h1>
      <p>Sign in with the Facebook account that manages the Pages you want to connect. After login, you can choose one or many Pages and route their leads into this Telegram group automatically.</p>
      <div class="note">
        <p style="margin:0;">This link is short-lived and tied to one Telegram group. If it expires, send <strong>/connect</strong> to <strong>WenzeLeadBots</strong> in the group again.</p>
      </div>
      <div class="actions">
        <a class="button" href="/facebook/oauth/start?session=${encodeURIComponent(session.session_token)}">Continue With Facebook</a>
      </div>
    `
  );
}

function renderPagePicker(session, profile, pages) {
  const pageCards = pages.map((page) => `
    <label class="page">
      <span class="checkbox-row">
        <input type="checkbox" name="page_id" value="${escapeHtml(page.id)}" checked>
        <span>
          <strong>${escapeHtml(page.name)}</strong><br>
          ${(page.tasks || []).map((task) => `<span class="pill">${escapeHtml(task)}</span>`).join('')}
        </span>
      </span>
    </label>
  `).join('');

  return renderFacebookCardPage(
    'Choose Pages',
    `
      <div class="group">Telegram Group: ${escapeHtml(session.group_name || String(session.telegram_group_id))}</div>
      <h1>Choose the Pages to connect</h1>
      <p>Signed in as <strong>${escapeHtml(profile?.name || session.oauth_user_name || 'Facebook user')}</strong>. Every Page you keep checked below will send new leads into this Telegram group.</p>
      <form method="POST" action="/facebook/connect/${encodeURIComponent(session.session_token)}/select-pages" class="stack">
        <div class="pages">
          ${pageCards}
        </div>
        <div class="actions">
          <button type="submit">Connect Selected Pages</button>
          <a class="button secondary" href="/facebook/connect/${encodeURIComponent(session.session_token)}">Start Over</a>
        </div>
      </form>
    `
  );
}

function renderConnectResultPage({ title, message, detailLines = [] }) {
  return renderFacebookCardPage(
    title,
    `
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${detailLines.length ? `<div class="note"><p style="margin:0; white-space:pre-line;">${escapeHtml(detailLines.join('\n'))}</p></div>` : ''}
    `
  );
}

module.exports = {
  escapeHtml,
  renderConnectLandingPage,
  renderPagePicker,
  renderConnectResultPage,
};
