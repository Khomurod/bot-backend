const crypto = require('crypto');
const config = require('../config/config');
const db = require('../database/db');
const { encryptText, decryptText } = require('./facebookCrypto');
const {
  buildFacebookLoginUrl,
  exchangeCodeForAccessToken,
  fetchFacebookPages,
  fetchFacebookProfile,
  describeFacebookTokenAccess,
  subscribePageToApp,
} = require('./facebookGraphService');

const CONNECT_SESSION_TTL_MS = 30 * 60 * 1000;

function nowPlusMs(ms) {
  return new Date(Date.now() + ms);
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function requirePublicBaseUrl() {
  const baseUrl = String(config.renderExternalUrl || '').trim();
  if (!baseUrl) {
    throw new Error('RENDER_EXTERNAL_URL is not configured');
  }
  return baseUrl.replace(/\/+$/, '');
}

function getSubscribedFieldsPreference() {
  return config.metaRequestedPermissions.includes('pages_messaging')
    ? ['leadgen', 'messages']
    : ['leadgen'];
}

function normalizeSelectedPageIds(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (value === undefined || value === null) return [];
  return [String(value)].filter(Boolean);
}

function ensureSessionIsUsable(session) {
  if (!session) throw new Error('Connect session was not found');
  if (session.status === 'completed') throw new Error('This connect link has already been used');
  if (session.status === 'expired' || new Date(session.expires_at).getTime() < Date.now()) {
    throw new Error('This connect link has expired. Send /connect again in Telegram.');
  }
  return session;
}

async function createConnectSession({ telegramGroupId, groupName, requestedBy }) {
  const group = await db.upsertGroup(telegramGroupId, groupName || 'Unknown');
  const sessionToken = randomToken();
  const session = await db.createFacebookConnectSession({
    sessionToken,
    groupId: group.id,
    telegramGroupId,
    groupName: groupName || group.group_name || 'Unknown',
    requestedByTelegramUserId: requestedBy?.id || null,
    requestedByName: requestedBy?.name || null,
    expiresAt: nowPlusMs(CONNECT_SESSION_TTL_MS),
  });
  const publicBaseUrl = requirePublicBaseUrl();
  return {
    session,
    connectUrl: `${publicBaseUrl}/facebook/connect/${sessionToken}`,
  };
}

async function getSessionByToken(sessionToken) {
  await db.expireOldFacebookConnectSessions();
  const session = await db.getFacebookConnectSessionByToken(sessionToken);
  return ensureSessionIsUsable(session);
}

async function buildLoginRedirectForSession(sessionToken) {
  const session = await getSessionByToken(sessionToken);
  const oauthState = randomToken();
  await db.updateFacebookConnectSessionOAuthState(session.id, oauthState);
  const publicBaseUrl = requirePublicBaseUrl();
  return buildFacebookLoginUrl({
    state: oauthState,
    redirectUri: `${publicBaseUrl}/facebook/oauth/callback`,
  });
}

async function finishOAuthCallback({ state, code }) {
  await db.expireOldFacebookConnectSessions();
  const session = ensureSessionIsUsable(await db.getFacebookConnectSessionByOAuthState(state));
  const publicBaseUrl = requirePublicBaseUrl();

  try {
    const userAccessToken = await exchangeCodeForAccessToken({
      code,
      redirectUri: `${publicBaseUrl}/facebook/oauth/callback`,
    });
    const [profile, pages] = await Promise.all([
      fetchFacebookProfile(userAccessToken),
      fetchFacebookPages(userAccessToken),
    ]);

    if (!pages.length) {
      const tokenAccess = await describeFacebookTokenAccess(userAccessToken);
      const scopeHint = Array.isArray(tokenAccess.scopes) && tokenAccess.scopes.length
        ? tokenAccess.scopes.join(', ')
        : 'none';
      const pageIdHint = Array.isArray(tokenAccess.pageIds) && tokenAccess.pageIds.length
        ? tokenAccess.pageIds.join(', ')
        : 'none';
      throw new Error(
        `Facebook did not return any Pages for this account. `
        + `Granted scopes: ${scopeHint}. `
        + `Page IDs in token: ${pageIdHint}. `
        + 'Re-run /connect and ensure WENZE Transport Services is selected, '
        + 'or add business_management to the Login configuration.'
      );
    }

    await db.storeFacebookConnectSessionOAuthResult(session.id, {
      oauthUserAccessTokenEncrypted: encryptText(userAccessToken),
      oauthUserId: profile?.id || null,
      oauthUserName: profile?.name || null,
    });

    return {
      session: {
        ...session,
        oauth_user_id: profile?.id || null,
        oauth_user_name: profile?.name || null,
      },
      profile,
      pages,
    };
  } catch (err) {
    await db.markFacebookConnectSessionError(session.id, err.message);
    throw err;
  }
}

async function connectSelectedPages({ sessionToken, selectedPageIds }) {
  const session = await getSessionByToken(sessionToken);
  if (!session.oauth_user_access_token_encrypted) {
    throw new Error('Facebook authorization is missing. Please restart with /connect.');
  }

  const userAccessToken = decryptText(session.oauth_user_access_token_encrypted);
  const pages = await fetchFacebookPages(userAccessToken);
  const selectedIds = normalizeSelectedPageIds(selectedPageIds);
  const pagesToConnect = pages.filter((page) => selectedIds.includes(String(page.id)));

  if (!pagesToConnect.length) {
    throw new Error('Choose at least one Facebook Page to connect');
  }

  const subscribedFieldsTarget = getSubscribedFieldsPreference();
  const grantedScopes = Array.from(config.metaRequestedPermissions);
  const results = [];

  for (const page of pagesToConnect) {
    let subscribedFields = subscribedFieldsTarget;
    let subscriptionStatus = 'connected';
    let subscriptionError = null;

    try {
      await subscribePageToApp({
        pageId: page.id,
        pageAccessToken: page.access_token,
        subscribedFields,
      });
    } catch (err) {
      if (subscribedFields.includes('messages')) {
        subscribedFields = ['leadgen'];
        try {
          await subscribePageToApp({
            pageId: page.id,
            pageAccessToken: page.access_token,
            subscribedFields,
          });
          subscriptionStatus = 'connected_leadgen_only';
          subscriptionError = `Messages subscription skipped: ${err.message}`;
        } catch (fallbackErr) {
          subscriptionStatus = 'subscription_failed';
          subscriptionError = fallbackErr.message;
        }
      } else {
        subscriptionStatus = 'subscription_failed';
        subscriptionError = err.message;
      }
    }

    const connection = await db.upsertFacebookPageConnection({
      groupId: session.group_id,
      telegramGroupId: session.telegram_group_id,
      groupName: session.group_name,
      pageId: page.id,
      pageName: page.name,
      accessTokenEncrypted: encryptText(page.access_token),
      tokenLast4: String(page.access_token || '').slice(-4),
      connectedByFacebookUserId: session.oauth_user_id,
      connectedByFacebookUserName: session.oauth_user_name,
      grantedTasks: Array.isArray(page.tasks) ? page.tasks : [],
      grantedScopes,
      subscribedFields,
      lastSubscriptionStatus: subscriptionStatus,
      lastError: subscriptionError,
    });

    results.push({
      connection,
      subscriptionStatus,
      subscriptionError,
    });
  }

  await db.markFacebookConnectSessionCompleted(session.id);
  return { session, results };
}

module.exports = {
  createConnectSession,
  getSessionByToken,
  buildLoginRedirectForSession,
  finishOAuthCallback,
  connectSelectedPages,
  normalizeSelectedPageIds,
};
