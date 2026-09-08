'use strict';

/**
 * LIVE credential checks for one recruiter's RingCentral number:
 *
 *   POST /:id/test      quick — authenticate and read their own call log
 *   POST /:id/diagnose  stepwise — credentials → auth → identity/number match
 *                       → SMS capability → call-log read
 *   POST /:id/test-sms  send a real text from their number to a number the
 *                       admin types, which is the only way to prove end to end
 *                       that lead texts will actually leave from it
 *
 * Both credential shapes are handled: a pasted JWT and a recruiter's own OAuth
 * login. A JWT supplied in the REQUEST BODY always wins, so an admin can verify
 * a token before saving it.
 *
 * Split out of server/routes/recruiterRoutes.js, which owns recruiter CRUD,
 * sync and stats. These live apart because they are the only routes here that
 * reach RingCentral live on every call.
 */
const { DateTime } = require('luxon');
const rc = require('../../../database/ringcentral');
const {
  getAccessToken,
  getExtensionInfoWithToken,
  fetchExtensionCallLogWithToken,
} = require('../../../services/ringCentralCallService');
const { getRecruiterAccessToken } = require('../../../services/ringCentralOAuthService');
const { sendSmsAsRecruiter } = require('../../../services/ringCentralSmsService');
const { phoneKey } = require('../../../lib/phone/e164');
const { diagnoseSenderNumber } = require('./senderNumberDiagnosis');

/**
 * Resolve the effective auth for a recruiter, letting the request body override
 * any piece so credentials can be tested BEFORE saving.
 */
async function resolveTestAuth(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return { error: 'Invalid id' };
  const recruiter = await rc.getRecruiterById(id);
  if (!recruiter) return { error: 'Recruiter not found', status: 404 };
  const cfg = await rc.getRcConfig();
  const stored = rc.resolveRecruiterRcAuth(recruiter, cfg);
  const bodyJwt = String(req.body?.jwtToken || '').trim();
  const auth = {
    apiBase: stored.apiBase,
    clientId: String(req.body?.clientId || '').trim() || stored.clientId,
    clientSecret: String(req.body?.clientSecret || '').trim() || stored.clientSecret,
    jwtToken: bodyJwt || stored.jwtToken,
    refreshToken: stored.refreshToken,
    // A JWT typed into the form is being tested, so it outranks a stored login.
    mode: bodyJwt ? 'jwt' : stored.mode,
    usesCustomClient: stored.usesCustomClient,
  };
  return { recruiter, cfg, auth };
}

/** An access token for whichever credential this recruiter is being tested on. */
async function resolveAccessToken({ recruiter, auth, cfg }) {
  if (auth.mode === 'oauth') {
    const { accessToken } = await getRecruiterAccessToken(recruiter, cfg);
    return accessToken;
  }
  return getAccessToken(auth);
}

function describeCredentials(auth) {
  if (auth.mode === 'oauth') return 'RingCentral login (this recruiter signed in)';
  if (auth.mode === 'jwt') return 'JWT token stored for this number';
  return 'Missing — have the recruiter connect RingCentral, or enter a JWT for this number.';
}

function registerRecruiterDiagnosticRoutes(router, { authMiddleware }) {
  // Quick per-number connectivity check: auth + read the recruiter's own log.
  router.post('/:id/test', authMiddleware, async (req, res) => {
    try {
      const { error, status, recruiter, cfg, auth } = await resolveTestAuth(req);
      if (error) return res.status(status || 400).json({ error });
      if (auth.mode === 'none') {
        return res.json({ connected: false, message: `No RingCentral credentials stored for ${recruiter.name}.` });
      }
      if (!auth.clientId || !auth.clientSecret) {
        return res.json({
          connected: false,
          message: 'Client ID/Secret missing (set the shared pair in Settings or a custom pair on this number).',
        });
      }
      const now = DateTime.now();
      if (auth.mode === 'oauth') {
        const accessToken = await resolveAccessToken({ recruiter, auth, cfg });
        const ext = await getExtensionInfoWithToken({ apiBase: auth.apiBase, accessToken });
        return res.json({
          connected: true,
          message: `Signed in as ${ext.name || 'this RingCentral user'}`
            + `${ext.smsNumber ? `, texting from ${ext.smsNumber}.` : ' — no SMS-capable number on this extension.'}`,
        });
      }
      const records = await fetchExtensionCallLogWithToken({
        apiBase: auth.apiBase,
        accessToken: await resolveAccessToken({ recruiter, auth, cfg }),
        dateFrom: now.startOf('day').toUTC().toISO(),
        dateTo: now.toUTC().toISO(),
      });
      return res.json({
        connected: true,
        message: `Authenticated. ${records.length} call(s) today on this number's extension.`,
      });
    } catch (err) {
      console.error('[RECRUITER API] test failed:', err.message);
      return res.json({ connected: false, message: err.message });
    }
  });

  // Stepwise diagnostic for one number, for the admin "Diagnose" button.
  router.post('/:id/diagnose', authMiddleware, async (req, res) => {
    const steps = [];
    const step = (label, ok, detail) => { steps.push({ label, ok, detail: detail || '' }); return ok; };
    try {
      const { error, status, recruiter, cfg, auth } = await resolveTestAuth(req);
      if (error) return res.status(status || 400).json({ error });

      // 1. Credentials present
      const credsOk = step('Credentials', auth.mode !== 'none', describeCredentials(auth));
      const clientOk = step(
        `Client ID/Secret (${auth.usesCustomClient ? 'custom for this number' : 'shared from Settings'})`,
        Boolean(auth.clientId && auth.clientSecret),
        auth.clientId && auth.clientSecret
          ? 'Resolved.'
          : 'Missing — set the shared pair in Settings → RingCentral or a custom pair on this number.'
      );
      if (!credsOk || !clientOk) return res.json({ ok: false, steps });

      // 2. Authenticate
      let accessToken = null;
      try {
        accessToken = await resolveAccessToken({ recruiter, auth, cfg });
        step('Authentication', true, auth.mode === 'oauth'
          ? 'Refresh token exchanged for an access token.'
          : 'JWT exchanged for an access token.');
      } catch (err) {
        step('Authentication', false, err.message);
        return res.json({ ok: false, steps });
      }

      // 3. Identity, number match and SMS capability — the three things that
      //    decide whether a lead text can actually leave from this number.
      try {
        const ext = await getExtensionInfoWithToken({ apiBase: auth.apiBase, accessToken });
        const who = [ext.name, ext.extensionNumber ? `ext. ${ext.extensionNumber}` : null]
          .filter(Boolean).join(', ');
        step('Extension identity', true, who || 'Resolved.');

        // Predicts what a REAL send will do — see senderNumberDiagnosis.js for
        // why comparing only the last ten digits reported a false green.
        const numberCheck = diagnoseSenderNumber({
          storedNumber: recruiter.phone_number,
          extensionPhoneNumbers: ext.phoneNumbers || [],
        });
        step(numberCheck.label, numberCheck.ok, numberCheck.detail);
        const wanted = phoneKey(recruiter.phone_number);

        const smsCapable = (ext.phoneNumberDetails || [])
          .filter((d) => d.features.includes('SmsSender'))
          .map((d) => d.phoneNumber);
        if (!ext.phoneNumberDetails?.length) {
          step('SMS capability', true, 'Phone-number details not readable — skipped.');
        } else if (smsCapable.map(phoneKey).includes(wanted)) {
          step('SMS capability', true, `${recruiter.phone_number} can send SMS.`);
        } else {
          step('SMS capability', false,
            smsCapable.length
              ? `SMS-capable on this extension: ${smsCapable.join(', ')} — but not ${recruiter.phone_number}.`
              : 'No SMS-capable number on this extension. Lead texts will fall back to the shared number.');
        }
      } catch (err) {
        step('Extension identity', false, err.message);
      }

      // 4. Call-log read + today's count
      try {
        const now = DateTime.now();
        const records = await fetchExtensionCallLogWithToken({
          apiBase: auth.apiBase,
          accessToken,
          dateFrom: now.startOf('day').toUTC().toISO(),
          dateTo: now.toUTC().toISO(),
        });
        const outbound = records.filter((r) => r.direction === 'Outbound').length;
        step('Call log read', true, `${records.length} call(s) today (${outbound} outbound).`);
      } catch (err) {
        step('Call log read', false, err.message);
      }

      return res.json({ ok: steps.every((s) => s.ok), steps });
    } catch (err) {
      console.error('[RECRUITER API] diagnose failed:', err.message);
      step('Diagnostic', false, err.message);
      return res.json({ ok: false, steps });
    }
  });

  /**
   * Send one real SMS from this recruiter's number. Deliberately requires an
   * explicit destination in the body — there is no default recipient, so this
   * can never text a driver by accident.
   */
  router.post('/:id/test-sms', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
      const to = String(req.body?.to || '').trim();
      if (rc.normalizePhone(to).length < 10) {
        return res.status(400).json({ error: 'Enter the full phone number to send the test to.' });
      }

      const recruiter = await rc.getRecruiterById(id);
      if (!recruiter) return res.status(404).json({ error: 'Recruiter not found' });

      const message = String(req.body?.message || '').trim()
        || `Test message from ${recruiter.name || 'the recruiting team'} at Wenze Transport Services.`;
      const result = await sendSmsAsRecruiter(recruiter, to, message);
      if (!result.ok) {
        return res.json({
          sent: false,
          message: `${result.reason}${result.detail ? `: ${result.detail}` : ''}`,
        });
      }
      return res.json({
        sent: true,
        message: `Sent from ${result.fromNumber} to ${to}.`,
        fromNumber: result.fromNumber,
        messageId: result.messageId,
      });
    } catch (err) {
      console.error('[RECRUITER API] test SMS failed:', err.message);
      return res.json({ sent: false, message: err.message });
    }
  });
}

module.exports = { registerRecruiterDiagnosticRoutes };
