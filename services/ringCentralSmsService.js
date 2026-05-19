const RC_PLATFORM_BASE = 'https://platform.ringcentral.com';

let cachedToken = { accessToken: '', expiresAt: 0 };

function getRingCentralConfig() {
  return {
    clientId: process.env.RC_CLIENT_ID || '',
    clientSecret: process.env.RC_CLIENT_SECRET || '',
    jwtToken: process.env.RC_JWT_TOKEN || '',
    fromNumber: process.env.RC_FROM_NUMBER || '',
  };
}

async function getAccessToken() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (cachedToken.accessToken && nowSeconds < cachedToken.expiresAt - 60) {
    return cachedToken.accessToken;
  }

  const { clientId, clientSecret, jwtToken } = getRingCentralConfig();
  if (!clientId || !clientSecret || !jwtToken) {
    throw new Error('RingCentral credentials are not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwtToken,
  });
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  const response = await fetch(`${RC_PLATFORM_BASE}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result?.access_token) {
    throw new Error(`RingCentral auth failed (${response.status}): ${JSON.stringify(result)}`);
  }

  cachedToken = {
    accessToken: result.access_token,
    expiresAt: nowSeconds + Number(result.expires_in || 3600),
  };
  return cachedToken.accessToken;
}

async function sendSms(to, message) {
  const { clientId, clientSecret, jwtToken, fromNumber } = getRingCentralConfig();
  if (!clientId || !clientSecret || !jwtToken || !fromNumber) {
    return { ok: false, reason: 'not_configured' };
  }

  try {
    const accessToken = await getAccessToken();
    const response = await fetch(`${RC_PLATFORM_BASE}/restapi/v1.0/account/~/extension/~/sms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { phoneNumber: fromNumber },
        to: [{ phoneNumber: to }],
        text: message,
      }),
    });

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      return {
        ok: true,
        messageId: data?.id != null ? String(data.id) : null,
        conversationId: data?.conversationId != null ? String(data.conversationId) : null,
      };
    }

    const text = await response.text();
    return { ok: false, reason: `http_${response.status}`, detail: text.slice(0, 500) };
  } catch (err) {
    return { ok: false, reason: 'exception', detail: err.message };
  }
}

module.exports = {
  sendSms,
};
