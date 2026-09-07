'use strict';

/**
 * "Log in with RingCentral" — how a recruiter attaches their OWN number.
 *
 * The problem this removes: per-recruiter sending needs a credential belonging
 * to each recruiter, and the only way to get one used to be an admin asking the
 * recruiter to generate a JWT in the RingCentral developer console and then
 * pasting that secret into a form. Every new hire meant a secret changing hands.
 *
 * Here the recruiter opens a link, presses one button, logs in to RingCentral,
 * and the app comes away with an authorization-code refresh token plus their
 * extension identity — read from RingCentral, not typed. Nobody handles the
 * secret and the number cannot be entered wrong.
 *
 * THE LINK IS THE CREDENTIAL. These routes carry no admin session (a recruiter
 * is not an admin), so the session token is single-use, expires in 30 minutes,
 * and `oauth_state` binds the redirect we sent to the callback we accept.
 *
 * Two shapes of invite:
 *   bound   — an admin invited an EXISTING recruiter row; tokens land on it.
 *   unbound — anyone with the link; the recruiter row is found by the number on
 *             the extension, or created from it. This is the "new recruiter
 *             joins and adds himself" path.
 */
const crypto = require('node:crypto');
const config = require('../config/config');
const rc = require('../database/ringcentral');
const { getExtensionInfoWithToken } = require('./ringCentralCallService');
const {
  buildRedirectUri,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
} = require('./ringCentralOAuthService');

const CONNECT_SESSION_TTL_MS = 30 * 60 * 1000;

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function requirePublicBaseUrl() {
  if (!config.publicBaseUrl) throw new Error('RENDER_EXTERNAL_URL is not configured');
  return config.publicBaseUrl;
}

/** The redirect URI that must be registered on the RingCentral app. */
function connectRedirectUri() {
  return buildRedirectUri(requirePublicBaseUrl());
}

function ensureSessionIsUsable(session) {
  if (!session) throw new Error('This RingCentral link was not found.');
  if (session.status === 'completed') throw new Error('This RingCentral link has already been used.');
  if (session.status === 'expired' || new Date(session.expires_at).getTime() < Date.now()) {
    throw new Error('This RingCentral link has expired. Ask for a new one.');
  }
  return session;
}

/**
 * Mint a link for a recruiter to authorize RingCentral.
 *
 * @param {object} [params]
 * @param {number|null} [params.recruiterId]  bind to an existing recruiter
 * @param {string|null} [params.invitedName]  shown on the landing page
 * @param {string|null} [params.createdBy]    who generated it, for the audit trail
 * @returns {Promise<{connectUrl:string, session:object, expiresAt:Date}>}
 */
async function createRecruiterConnectLink({ recruiterId = null, invitedName = null, createdBy = null } = {}) {
  const cfg = await rc.getRcConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      'Set the shared RingCentral Client ID and Secret in Settings → RingCentral before inviting a recruiter.'
    );
  }

  let name = invitedName;
  if (recruiterId) {
    const recruiter = await rc.getRecruiterById(recruiterId);
    if (!recruiter) throw new Error('Recruiter not found.');
    name = name || recruiter.name;
  }

  const publicBaseUrl = requirePublicBaseUrl();
  await rc.expireOldRcConnectSessions();
  const sessionToken = randomToken();
  const expiresAt = new Date(Date.now() + CONNECT_SESSION_TTL_MS);
  const session = await rc.createRcConnectSession({
    sessionToken,
    recruiterId,
    invitedName: name,
    createdBy,
    expiresAt,
  });

  return {
    connectUrl: `${publicBaseUrl}/ringcentral/connect/${sessionToken}`,
    session,
    expiresAt,
  };
}

/** The session behind a link, with the recruiter it is bound to (if any). */
async function getConnectSession(sessionToken) {
  await rc.expireOldRcConnectSessions();
  const session = ensureSessionIsUsable(await rc.getRcConnectSessionByToken(sessionToken));
  const recruiter = session.recruiter_id ? await rc.getRecruiterById(session.recruiter_id) : null;
  return { session, recruiter };
}

/** Where to send the recruiter's browser, with a fresh CSRF state stored. */
async function buildConnectRedirect(sessionToken) {
  const { session } = await getConnectSession(sessionToken);
  const cfg = await rc.getRcConfig();
  const oauthState = randomToken();
  await rc.setRcConnectSessionOAuthState(session.id, oauthState);
  return buildAuthorizeUrl({
    apiBase: cfg.apiBase,
    clientId: cfg.clientId,
    redirectUri: connectRedirectUri(),
    state: oauthState,
  });
}

/**
 * Attach the authorized extension to a recruiter row.
 *
 * Bound sessions keep their recruiter; unbound ones match on the extension's
 * SMS number and create the recruiter when there is no match — the number is
 * read from RingCentral rather than typed, so it is right by construction.
 *
 * @returns {Promise<{recruiter:object, created:boolean, warning:string|null}>}
 */
async function attachExtensionToRecruiter({ session, extension, refreshToken }) {
  const smsNumber = extension.smsNumber;
  const extensionId = extension.extensionId;
  const extensionNumber = extension.extensionNumber;

  if (session.recruiter_id) {
    const recruiter = await rc.getRecruiterById(session.recruiter_id);
    if (!recruiter) throw new Error('The recruiter this link was created for no longer exists.');
    await rc.storeRecruiterOAuthTokens(recruiter.id, { refreshToken, extensionId, extensionNumber });

    // A login for the wrong extension authenticates fine and then fails on
    // every send, so say so now rather than letting leads quietly fall back.
    let warning = null;
    const owned = (extension.phoneNumbers || []).map(rc.normalizePhone);
    const wanted = rc.normalizePhone(recruiter.phone_number);
    if (owned.length && !owned.includes(wanted)) {
      warning = `This RingCentral user owns ${extension.phoneNumbers.join(', ')}, not ${recruiter.phone_number}. `
        + 'Texts from that number will be rejected until the number on file is corrected.';
      await rc.markRecruiterAuthError(recruiter.id, warning);
    }
    return { recruiter: await rc.getRecruiterById(recruiter.id), created: false, warning };
  }

  if (!smsNumber) {
    throw new Error(
      'This RingCentral user has no SMS-capable direct number, so it cannot be used to text leads. '
      + 'Ask your RingCentral admin to assign one, then open the link again.'
    );
  }

  const existing = await rc.getRecruiterByNormalizedNumber(rc.normalizePhone(smsNumber));
  if (existing) {
    await rc.storeRecruiterOAuthTokens(existing.id, { refreshToken, extensionId, extensionNumber });
    return { recruiter: await rc.getRecruiterById(existing.id), created: false, warning: null };
  }

  const created = await rc.createRecruiter({
    name: session.invited_name || extension.name || smsNumber,
    phoneNumber: smsNumber,
    refreshToken,
    rcExtensionId: extensionId,
    rcExtensionNumber: extensionNumber,
  });
  return { recruiter: await rc.getRecruiterById(created.id), created: true, warning: null };
}

/**
 * Finish the RingCentral callback: validate the state, trade the code for
 * tokens, read the extension, and store both against a recruiter.
 *
 * @returns {Promise<{recruiter:object, extension:object, created:boolean, warning:string|null}>}
 */
async function finishConnectCallback({ state, code }) {
  await rc.expireOldRcConnectSessions();
  const session = ensureSessionIsUsable(await rc.getRcConnectSessionByOAuthState(state));

  try {
    if (!code) throw new Error('RingCentral did not return an authorization code.');
    const cfg = await rc.getRcConfig();
    const tokens = await exchangeAuthorizationCode({
      apiBase: cfg.apiBase,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
      redirectUri: connectRedirectUri(),
    });
    if (!tokens.refreshToken) {
      throw new Error(
        'RingCentral returned no refresh token. Enable the Refresh Token grant on the app and try again.'
      );
    }

    const extension = await getExtensionInfoWithToken({
      apiBase: cfg.apiBase,
      accessToken: tokens.accessToken,
    });

    const attached = await attachExtensionToRecruiter({
      session,
      extension,
      refreshToken: tokens.refreshToken,
    });
    await rc.completeRcConnectSession(session.id, attached.recruiter.id);
    return { ...attached, extension };
  } catch (err) {
    // Recorded, not consumed: a cancelled or failed attempt can be retried on
    // the same link while it is still valid.
    await rc.markRcConnectSessionError(session.id, err.message).catch(() => {});
    throw err;
  }
}

module.exports = {
  CONNECT_SESSION_TTL_MS,
  connectRedirectUri,
  createRecruiterConnectLink,
  getConnectSession,
  buildConnectRedirect,
  attachExtensionToRecruiter,
  finishConnectCallback,
};
