const crypto = require('crypto');
const config = require('../config/config');

function graphBaseUrl() {
  return `https://graph.facebook.com/${config.metaGraphVersion}`;
}

function buildAppSecretProof(accessToken) {
  return crypto
    .createHmac('sha256', String(config.metaAppSecret || ''))
    .update(String(accessToken || ''))
    .digest('hex');
}

async function graphRequest(path, {
  method = 'GET',
  accessToken = '',
  query = {},
  form = null,
} = {}) {
  const url = new URL(`${graphBaseUrl()}${path}`);
  const params = new URLSearchParams();

  const token = String(accessToken || '').trim();
  if (token) {
    params.set('access_token', token);
    if (config.metaAppSecret) {
      params.set('appsecret_proof', buildAppSecretProof(token));
    }
  }

  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }

  let body = undefined;
  const headers = {};
  if (method === 'GET') {
    url.search = params.toString();
  } else if (form) {
    for (const [key, value] of Object.entries(form || {})) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = params.toString();
  } else {
    url.search = params.toString();
  }

  const response = await fetch(url, { method, headers, body });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error?.message || JSON.stringify(payload) || response.statusText;
    throw new Error(`Meta Graph request failed (${response.status}): ${detail}`);
  }
  return payload;
}

function buildFacebookLoginUrl({ state, redirectUri }) {
  if (!config.metaAppId) {
    throw new Error('META_APP_ID is not configured');
  }

  const url = new URL(`https://www.facebook.com/${config.metaGraphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', config.metaAppId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');

  if (config.metaLoginConfigId) {
    url.searchParams.set('config_id', config.metaLoginConfigId);
  } else {
    url.searchParams.set('scope', config.metaRequestedPermissions.join(','));
  }

  return url.toString();
}

async function exchangeCodeForAccessToken({ code, redirectUri }) {
  if (!config.metaAppId || !config.metaAppSecret) {
    throw new Error('META_APP_ID and META_APP_SECRET must be configured');
  }

  const url = new URL(`${graphBaseUrl()}/oauth/access_token`);
  url.searchParams.set('client_id', config.metaAppId);
  url.searchParams.set('client_secret', config.metaAppSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);

  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    const detail = payload?.error?.message || JSON.stringify(payload) || response.statusText;
    throw new Error(`Meta OAuth exchange failed (${response.status}): ${detail}`);
  }
  return payload.access_token;
}

async function fetchFacebookProfile(userAccessToken) {
  return graphRequest('/me', {
    accessToken: userAccessToken,
    query: { fields: 'id,name' },
  });
}

async function fetchFacebookPages(userAccessToken) {
  const payload = await graphRequest('/me/accounts', {
    accessToken: userAccessToken,
    query: { fields: 'id,name,access_token,tasks' },
  });
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function subscribePageToApp({ pageId, pageAccessToken, subscribedFields }) {
  return graphRequest(`/${pageId}/subscribed_apps`, {
    method: 'POST',
    accessToken: pageAccessToken,
    form: {
      subscribed_fields: subscribedFields.join(','),
    },
  });
}

async function fetchLeadById({ leadgenId, pageAccessToken }) {
  return graphRequest(`/${leadgenId}`, {
    accessToken: pageAccessToken,
    query: {
      fields: 'field_data,created_time,id',
    },
  });
}

async function fetchSenderProfile({ senderId, pageAccessToken }) {
  try {
    return await graphRequest(`/${senderId}`, {
      accessToken: pageAccessToken,
      query: {
        fields: 'first_name,last_name,name,profile_pic',
      },
    });
  } catch {
    return {};
  }
}

module.exports = {
  buildAppSecretProof,
  buildFacebookLoginUrl,
  exchangeCodeForAccessToken,
  fetchFacebookProfile,
  fetchFacebookPages,
  subscribePageToApp,
  fetchLeadById,
  fetchSenderProfile,
};
