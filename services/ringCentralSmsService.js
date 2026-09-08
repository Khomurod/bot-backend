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
 *
 * `from` MUST BE E.164. This is the second half of the same constraint and it
 * is the one that was missed: `recruiters.phone_number` holds whatever an admin
 * typed — `(470) 480-4679`, `4702400064`, `470-419-4110` — and handing that
 * string to RingCentral produces
 *
 *   InvalidParameter / MSG-245
 *   Parameter [from] value [...] is invalid
 *   [Cannot find the phone number which belongs to user]
 *
 * which reads like an authentication problem and is not one: the token is
 * right, the number is merely unrecognizable. Every send therefore goes through
 * `toE164`, and a rejection is checked against what the extension actually owns
 * rather than reported as an opaque provider error.
 */
const rc = require('../database/ringcentral');
const { getRecruiterAccessToken } = require('./ringCentralOAuthService');
const { getExtensionInfoWithToken } = require('./ringCentralCallService');
const { toE164, sameNumber } = require('../lib/phone/e164');

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
 * Did RingCentral reject this specifically because it does not recognize
 * `from`? That is worth a second look at the extension; any other 4xx (an
 * unregistered A2P campaign, a bad `to`, a blocked recipient) is not.
 *
 * Matched on RingCentral's own error code rather than the prose, which is
 * localized and has changed wording before.
 */
function isFromNumberRejection(result) {
  if (result?.ok) return false;
  const detail = String(result?.detail || '');
  if (/MSG-245/.test(detail)) return true;
  // Same condition, older/alternate spelling: an InvalidParameter naming [from].
  return /InvalidParameter/i.test(detail) && /\[from\]/i.test(detail);
}

/**
 * What does this extension ACTUALLY own? Asked only after a `from` rejection,
 * so the happy path costs nothing.
 *
 * Returns the extension's own spelling of the number we tried (when it is
 * there at all), whether that number can send SMS, and the extension identity —
 * which is also how a JWT recruiter's `rc_extension_id` gets discovered, since
 * only the OAuth sign-in flow ever populated it.
 */
async function inspectSenderNumber({ apiBase, accessToken, fromNumber }) {
  const info = await getExtensionInfoWithToken({ apiBase, accessToken });
  const details = Array.isArray(info?.phoneNumberDetails) ? info.phoneNumberDetails : [];
  const owned = details.find((d) => sameNumber(d?.phoneNumber, fromNumber)) || null;
  return {
    extensionId: info?.extensionId || null,
    extensionNumber: info?.extensionNumber || null,
    owned,
    // RingCentral's own E.164 for the number we were trying to send from.
    canonical: owned?.phoneNumber || null,
    smsCapable: Boolean(owned && (owned.features || []).includes('SmsSender')),
    // The number RingCentral would have us use instead, when it knows one.
    smsNumber: info?.smsNumber || null,
  };
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
  // The stored column is whatever a human typed. RingCentral needs E.164, and
  // a value we cannot turn into one is a configuration problem, not a send to
  // attempt — so it is reported without spending a request.
  const fromNumber = toE164(recruiter?.phone_number);
  const toNumber = toE164(to);
  if (!recruiter?.id) {
    return { ok: false, reason: 'recruiter_not_configured', recruiterId: null };
  }
  if (!fromNumber) {
    // Distinct from `recruiter_not_configured`: this recruiter HAS credentials,
    // their stored number just is not one. Reporting it as "no credentials"
    // sends an operator to re-connect a RingCentral login that is working fine.
    return {
      ok: false,
      reason: 'recruiter_number_unusable',
      detail: `"${recruiter.phone_number ?? ''}" is not a phone number this can send from.`,
      recruiterId: recruiter.id,
    };
  }

  try {
    const cfg = await rc.getRcConfig();
    const { accessToken, apiBase, mode } = await getRecruiterAccessToken(recruiter, cfg);
    const result = await postSms({ apiBase, accessToken, fromNumber, to: toNumber || to, message });
    if (result.ok || !isFromNumberRejection(result)) {
      return { ...result, recruiterId: recruiter.id, authMode: mode };
    }

    // RingCentral does not recognize the number. Ask it what this extension
    // owns, so the answer is a named state an operator can act on instead of
    // MSG-245. NEVER retried with the shared token: that authenticates and
    // still fails, and the fallback is the shared NUMBER (App Brief §9.11).
    let seen;
    try {
      seen = await inspectSenderNumber({ apiBase, accessToken, fromNumber });
    } catch (inspectErr) {
      // The extension read is an enrichment; losing it must not change the
      // outcome, only how well we can describe it.
      return {
        ...result,
        reason: 'recruiter_send_failed',
        recruiterId: recruiter.id,
        authMode: mode,
        inspectError: inspectErr.message,
      };
    }

    // Four distinguishable states, and they need different fixes.
    if (seen.owned && seen.smsCapable && seen.canonical && seen.canonical !== fromNumber) {
      // Same line, spelled differently by RingCentral — an admin who typed a
      // stray country code lands here. Send it their way rather than falling
      // back to a number the driver has never seen.
      const retry = await postSms({
        apiBase, accessToken, fromNumber: seen.canonical, to: toNumber || to, message,
      });
      return {
        ...retry,
        reason: retry.ok ? undefined : 'recruiter_send_failed',
        recruiterId: recruiter.id,
        authMode: mode,
        correctedFrom: seen.canonical,
        extensionId: seen.extensionId,
      };
    }

    const reason = !seen.owned
      ? 'recruiter_number_not_on_extension'
      : !seen.smsCapable
        ? 'recruiter_number_not_sms_capable'
        // Owned, SMS-capable, and exactly what we sent — RingCentral is
        // refusing something its own extension record says should work. Report
        // the refusal honestly rather than blaming a capability that is there.
        : 'recruiter_send_failed';
    return {
      ...result,
      reason,
      recruiterId: recruiter.id,
      authMode: mode,
      attemptedFrom: fromNumber,
      // What they COULD send from, when RingCentral names one. Not used
      // automatically: silently texting a driver from a different line than the
      // operator configured is the wrong kind of helpful.
      extensionSmsNumber: seen.smsNumber,
      extensionId: seen.extensionId,
    };
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
