'use strict';

/**
 * Which RingCentral extension is each recruiter?
 *
 * THE PROBLEM THIS SOLVES. An inbound-SMS subscription is built one event
 * filter per extension id (`leads-bot/sms.py → inbound_sms_filters`), read from
 * `recruiters.rc_extension_id`. That column was written by exactly one code
 * path: the OAuth "sign in with RingCentral" callback. A recruiter onboarded
 * the other supported way — an admin pasting their JWT in Settings — therefore
 * had it NULL, and:
 *
 *   · `recruiterCanSendSms()` said yes, so their leads WERE texted from their
 *     own number;
 *   · `listRecruitersWithOwnCredentials()` included them;
 *   · and then `/api/internal/ringcentral/sms-extensions` dropped them, because
 *     a NULL cannot become a filter.
 *
 * So the driver got a text from a number whose replies nothing was watching.
 * The identity is not a credential and not a secret — it is readable from
 * RingCentral with the token we already hold — so there is no reason for it to
 * be missing.
 *
 * `getExtensionInfoWithToken` is the same read the OAuth callback and the
 * per-recruiter Diagnose button already use.
 */
const rc = require('../database/ringcentral');
const { getExtensionInfoWithToken } = require('./ringCentralCallService');
const { getRecruiterAccessToken } = require('./ringCentralOAuthService');

/** Does this row still need its extension identity? */
function needsExtensionIdentity(recruiter) {
  return Boolean(recruiter?.id) && !String(recruiter.rc_extension_id || '').trim();
}

/**
 * Store an identity we already have in hand, when it is new or has changed.
 *
 * Never throws: this is bookkeeping beside whatever the caller was really
 * doing, and losing it must not fail that.
 *
 * @returns {Promise<string|null>} the extension id now on record, or null
 */
async function rememberExtensionIdentity(recruiter, info) {
  const extensionId = info?.extensionId ? String(info.extensionId) : '';
  if (!recruiter?.id || !extensionId) return null;
  if (String(recruiter.rc_extension_id || '') === extensionId) return extensionId;

  try {
    await rc.updateRecruiterRcIdentity(recruiter.id, {
      extensionId,
      extensionNumber: info?.extensionNumber || null,
    });
    return extensionId;
  } catch (err) {
    console.warn(
      `[RC-IDENTITY] Could not record the extension for ${recruiter.name || `recruiter ${recruiter.id}`}: ${err.message}`
    );
    return null;
  }
}

/**
 * Read this recruiter's extension from RingCentral and record it.
 *
 * Costs one request, and only for a recruiter who is missing the identity —
 * the caller decides that with `needsExtensionIdentity`. Works for a JWT and an
 * OAuth credential alike, because `getRecruiterAccessToken` is the one place
 * either becomes a bearer token.
 *
 * @returns {Promise<string|null>} the extension id now on record, or null
 */
async function backfillExtensionIdentity(recruiter, cfg) {
  const { accessToken, apiBase } = await getRecruiterAccessToken(recruiter, cfg);
  const info = await getExtensionInfoWithToken({ apiBase, accessToken });
  return rememberExtensionIdentity(recruiter, info);
}

module.exports = {
  needsExtensionIdentity,
  rememberExtensionIdentity,
  backfillExtensionIdentity,
};
