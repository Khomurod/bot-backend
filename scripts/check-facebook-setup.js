#!/usr/bin/env node
/**
 * Smoke-check public URLs for Meta / Facebook connect (no secrets required).
 * Usage: node scripts/check-facebook-setup.js [baseUrl]
 */
const base = (process.argv[2] || process.env.RENDER_EXTERNAL_URL || 'https://bot-backend-x9lc.onrender.com').replace(/\/+$/, '');

const paths = [
  { path: '/api/health', expect: 200, label: 'API health' },
  { path: '/privacy-policy.html', expect: 200, label: 'Privacy policy' },
  { path: '/terms-of-use', expect: 200, label: 'Terms of use' },
  { path: '/user-data-deletion', expect: 200, label: 'Data deletion' },
  { path: '/facebook/oauth/callback', expect: [400, 200], label: 'OAuth callback route' },
];

async function checkOne({ path, expect, label }) {
  const url = `${base}${path}`;
  const res = await fetch(url, { method: 'GET', redirect: 'manual' });
  const codes = Array.isArray(expect) ? expect : [expect];
  const ok = codes.includes(res.status);
  console.log(`${ok ? 'OK' : 'FAIL'}  ${label}: ${res.status} ${url}`);
  return ok;
}

async function checkMetaCredentials(baseUrl) {
  const url = `${baseUrl}/api/health`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`FAIL  Meta credentials: health returned ${res.status}`);
    return false;
  }
  const body = await res.json().catch(() => null);
  const meta = body?.meta;
  if (!meta?.configured) {
    console.log('WARN  Meta credentials: META_APP_ID / META_APP_SECRET not set on server');
    return false;
  }
  if (meta.valid) {
    console.log(`OK    Meta credentials: app ${meta.appId} secret validates with Meta`);
    return true;
  }
  console.log(`FAIL  Meta credentials: ${meta.error || 'invalid'} (app ${meta.appId})`);
  console.log('      Fix META_APP_SECRET in Render → App settings → Basic → App secret');
  return false;
}

(async () => {
  console.log(`Checking ${base} ...\n`);
  let allOk = true;
  for (const item of paths) {
    try {
      const ok = await checkOne(item);
      if (!ok) allOk = false;
    } catch (err) {
      console.log(`FAIL  ${item.label}: ${err.message}`);
      allOk = false;
    }
  }
  try {
    const metaOk = await checkMetaCredentials(base);
    if (!metaOk) allOk = false;
  } catch (err) {
    console.log(`FAIL  Meta credentials: ${err.message}`);
    allOk = false;
  }
  console.log(allOk ? '\nAll checks passed.' : '\nSome checks failed — see messages above.');
  process.exit(allOk ? 0 : 1);
})();
