/**
 * Real HTTP E2E against AI Insights + Ask the Data (local API only).
 *
 * Usage (from repo root):
 *   set E2E_PORT=3999
 *   set E2E_DAYS_BACK=2
 *   node -r dotenv/config scripts/e2e-ai-insights-live.js
 *
 * Requires .env with DATABASE_URL, ADMIN_*, JWT_SECRET, PORT ignored (E2E_PORT wins).
 */
const path = require('path');
// Preempt a host-level DATABASE_URL=localhost (or other) that would otherwise
// win over the project .env and make the E2E talk to the wrong database.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const db = require('../database/db');
const { app } = require('../server/api');

const E2E_PORT = Number(process.env.E2E_PORT || 3999);
const DAYS_BACK = Math.min(30, Math.max(1, Number(process.env.E2E_DAYS_BACK || 2)));
const SKIP_GENERATE = process.env.E2E_SKIP_GENERATE === '1';

async function httpJson(base, method, pathname, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const timeoutMs = pathname.includes('ai-insights/generate') ? 900_000 : 120_000;
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

async function main() {
  console.log('[E2E] Initializing database (applies schema if needed)...');
  await db.initializeDatabase();
  console.log('[E2E] Database ready.');

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(E2E_PORT, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const base = `http://127.0.0.1:${E2E_PORT}`;

  try {
    const health = await httpJson(base, 'GET', '/api/health');
    console.log('\n=== GET /api/health ===');
    console.log('status:', health.status);
    console.log('body:', JSON.stringify(health.json, null, 2).slice(0, 1200));

    const user = process.env.ADMIN_USERNAME || 'admin';
    const pass = process.env.ADMIN_PASSWORD;
    if (!pass) {
      throw new Error('ADMIN_PASSWORD missing from environment');
    }

    const login = await httpJson(base, 'POST', '/api/auth/login', { username: user, password: pass });
    console.log('\n=== POST /api/auth/login ===');
    console.log('status:', login.status);
    if (!login.json.token) {
      console.log('body:', JSON.stringify(login.json, null, 2));
      throw new Error('Login failed — check ADMIN_USERNAME / ADMIN_PASSWORD and admins table.');
    }
    console.log('token: <redacted>, length=', login.json.token.length);

    const token = login.json.token;

    console.log('\n=== POST /api/ai-ask (Groq plan + SQL + narrative) ===');
    const ask = await httpJson(
      base,
      'POST',
      '/api/ai-ask',
      {
        question:
          'In the last 30 days, which senders had the most messages with intent home_time_request? Show top 5 as a count per sender_name.',
      },
      token
    );
    console.log('status:', ask.status);
    if (ask.status !== 200) {
      console.log('body:', JSON.stringify(ask.json, null, 2).slice(0, 2500));
    } else {
      console.log('row_count:', ask.json.row_count);
      console.log('plan:', JSON.stringify(ask.json.plan, null, 2)?.slice(0, 1500));
      console.log('sql (truncated):', String(ask.json.sql || '').slice(0, 600));
      console.log('answer_html (first 1200 chars):\n', String(ask.json.answer_html || '').slice(0, 1200));
      if (Array.isArray(ask.json.rows) && ask.json.rows.length) {
        console.log('sample row[0]:', JSON.stringify(ask.json.rows[0], null, 2));
      }
    }

    if (SKIP_GENERATE) {
      console.log('\n[E2E] E2E_SKIP_GENERATE=1 — skipping /api/ai-insights/generate');
      return;
    }

    console.log(`\n=== POST /api/ai-insights/generate (daysBack=${DAYS_BACK}, may take a long time) ===`);
    const gen = await httpJson(base, 'POST', '/api/ai-insights/generate', { daysBack: DAYS_BACK }, token);
    console.log('status:', gen.status);
    if (gen.status !== 201) {
      console.log('body:', JSON.stringify(gen.json, null, 2).slice(0, 4000));
    } else {
      const { report, cards, pulse } = gen.json;
      console.log('report.id:', report?.id);
      console.log('pulse:', JSON.stringify(pulse, null, 2));
      console.log('cards:', cards?.length, '— kinds:', cards?.map((c) => c.kind).join(', '));
      if (cards?.length) {
        const first = cards.find((c) => c.kind !== 'pulse') || cards[0];
        console.log('sample card title:', first?.title);
        console.log('sample narrative (first 500 chars):\n', String(first?.narrative_html || '').slice(0, 500));
      }
    }

    console.log('\n[E2E] Done.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
  }
}

main().catch((err) => {
  console.error('[E2E] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
