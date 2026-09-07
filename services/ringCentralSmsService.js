/**
 * RingCentral SMS sending.
 *
 * TWO SENDERS, ONE HTTP CALL. RingCentral rejects an SMS whose `from` is not a
 * number on the extension the token belongs to — a super-admin token cannot
 * send "on behalf of" a colleague — so sending as a particular person means
 * using that person's own credentials:
 *
 *   sendSms(to, text)                     the SHARED company number
 *                                         (RC_FROM_NUMBER, env JWT). Used by
 *                                         OTP, the Indeed path, and as the
 *                                         fallback whenever no recruiter can be
 *                                         resolved for a lead.
 *   sendSmsAsRecruiter(rec, to, text)     that recruiter's own number, with
 *                                         their own OAuth/JWT credential
 *                                         (services/ringCentralOAuthService).
 *
 * Both return the same shape and NEVER throw: SMS is best-effort next to the
 * Telegram post and the CRM record, and a caller decides what a failure means.
 * A recruiter-send failure is reported with a `reason` the caller can act on,
 * which is how the lead flow knows to fall back to the shared number and say so
 * out loud instead of dropping the lead's text.
 */
const rc = require('../database/ringcentral');
const { getRecruiterAccessToken } = require('./ringCentralOAuthService');

const RC_PLATFORM_BASE = 'https://platform.ringcentral.com';

let cachedToken = { accessToken: '', expiresAt: 0 };

function getRingCentralConfig() {
  return {
    clientId: process.env.RC_CLIENT_ID || '',
    clientSecret: process.env.RC_CLIENT_SECRET || '',
    jwtToken: process.env.RC_JWT_TOKEN || '',
    fromNumber: process.env.RC_FROM_NUMBER || '+14704804679',
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

/**
 * POST one SMS. `~/~` is deliberate: the extension is whoever the access token
 * belongs to, and `from` must be one of THAT extension's numbers.
 */
async function postSms({ apiBase, accessToken, fromNumber, to, message }) {
  const response = await fetch(
    `${String(apiBase || RC_PLATFORM_BASE).replace(/\/+$/, '')}/restapi/v1.0/account/~/extension/~/sms`,
    {
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
    }
  );

  if (response.ok) {
    const data = await response.json().catch(() => ({}));
    return {
      ok: true,
      fromNumber,
      messageId: data?.id != null ? String(data.id) : null,
      conversationId: data?.conversationId != null ? String(data.conversationId) : null,
    };
  }

  const text = await response.text();
  return { ok: false, reason: `http_${response.status}`, detail: text.slice(0, 500), fromNumber };
}

/** Send from the shared company number. Unchanged behaviour. */
async function sendSms(to, message) {
  const { clientId, clientSecret, jwtToken, fromNumber } = getRingCentralConfig();
  if (!clientId || !clientSecret || !jwtToken || !fromNumber) {
    return { ok: false, reason: 'not_configured' };
  }

  try {
    const accessToken = await getAccessToken();
    return await postSms({ apiBase: RC_PLATFORM_BASE, accessToken, fromNumber, to, message });
  } catch (err) {
    return { ok: false, reason: 'exception', detail: err.message };
  }
}

/**
 * Send from ONE recruiter's own RingCentral number, using their own credential.
 *
 * @param {object} recruiter  a `recruiters` row (needs id + phone_number)
 * @param {string} to
 * @param {string} message
 * @returns {Promise<{ok:boolean, fromNumber?:string, messageId?:string|null,
 *   conversationId?:string|null, reason?:string, detail?:string,
 *   recruiterId?:number, authMode?:string}>}
 */
async function sendSmsAsRecruiter(recruiter, to, message) {
  const fromNumber = String(recruiter?.phone_number || '').trim();
  if (!recruiter?.id || !fromNumber) {
    return { ok: false, reason: 'recruiter_not_configured', recruiterId: recruiter?.id ?? null };
  }

  try {
    const cfg = await rc.getRcConfig();
    const { accessToken, apiBase, mode } = await getRecruiterAccessToken(recruiter, cfg);
    const result = await postSms({ apiBase, accessToken, fromNumber, to, message });
    return { ...result, recruiterId: recruiter.id, authMode: mode };
  } catch (err) {
    // Credential problems are the caller's cue to fall back to the shared
    // number, so they are reported distinctly from a rejected message.
    const reason = err.code === 'RC_NO_RECRUITER_CREDENTIALS'
      ? 'recruiter_not_configured'
      : 'recruiter_auth_failed';
    return { ok: false, reason, detail: err.message, recruiterId: recruiter.id, code: err.code };
  }
}

module.exports = {
  sendSms,
  sendSmsAsRecruiter,
};
