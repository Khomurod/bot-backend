'use strict';

/**
 * The TLS setting for a PostgreSQL connection string — pure.
 *
 * Hosted databases (Supabase, Neon, or any URL that asks for
 * `sslmode=require`) are reached over TLS without verifying the certificate
 * chain, which their poolers present from a shared certificate; a local or
 * test database is reached without TLS. One rule, used by the shared pool
 * (database/pool.js) and by the boot-time read of the app secrets
 * (config/appSecretsFetch.js), which runs before that pool exists.
 */
function sslForUrl(url) {
  const text = String(url || '');
  if (!text) return false;
  if (text.includes('sslmode=require') || text.includes('supabase') || text.includes('neon')) {
    return { rejectUnauthorized: false };
  }
  return false;
}

module.exports = { sslForUrl };
