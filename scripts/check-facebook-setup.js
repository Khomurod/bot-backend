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
  console.log(allOk ? '\nAll public checks passed.' : '\nSome checks failed — deploy or fix routes first.');
  process.exit(allOk ? 0 : 1);
})();
