'use strict';

/**
 * TRAILER_DEPARTMENT_ENABLED resolution.
 *
 * The department is ON by default so a deployment (or a local checkout) that
 * never sets the variable still serves the APIs. `false` remains the emergency
 * kill switch. An explicitly-supplied value that is neither `true` nor `false`
 * is a configuration mistake, so it fails closed rather than silently enabling
 * a department the operator clearly meant to control.
 */
function resolveTrailerDepartmentEnabled(rawValue) {
  if (rawValue === undefined || rawValue === null) return true;
  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === '') return true;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  console.error(
    `[CONFIG] TRAILER_DEPARTMENT_ENABLED must be "true" or "false" (got "${normalized}") — `
    + 'the Trailer Department stays disabled until this is corrected.',
  );
  return false;
}

module.exports = { resolveTrailerDepartmentEnabled };
