'use strict';

/**
 * Deterministic content checksum for a migration's SQL.
 *
 * Used to detect when an already-applied migration file has been edited after
 * the fact (migrations are meant to be immutable once applied). Line endings
 * are normalized so a CRLF/LF flip on a checkout does not read as drift.
 */
const crypto = require('node:crypto');

function checksum(sql) {
  const normalized = String(sql).replace(/\r\n/g, '\n');
  return `sha256:${crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

module.exports = { checksum };
