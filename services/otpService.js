/**
 * One-time passcode (OTP) delivery + verification helpers for the driver raise
 * approval flow.
 *
 * No third-party OTP provider: codes are delivered either through the company's
 * own Gmail (App Password via Nodemailer SMTP) or the already-configured
 * RingCentral SMS sender. The admin picks the channel in raise_settings.
 */
const crypto = require('node:crypto');
const config = require('../config/config');
const { sendSms } = require('./ringCentralSmsService');
const { toE164 } = require('../lib/phone/e164');

const CODE_LENGTH = 6;

let cachedGmailTransport = null;
let cachedGmailUser = null;

/** Resolve Gmail creds: admin-panel values win, falling back to env. */
function resolveGmailCreds(creds = {}) {
  return {
    user: creds.gmailUser || config.gmailUser || '',
    pass: creds.gmailAppPassword || config.gmailAppPassword || '',
    from: creds.gmailFrom || creds.gmailUser || config.gmailFrom || config.gmailUser || '',
  };
}

/** Six-digit numeric passcode as a zero-padded string. */
function generateCode() {
  const n = crypto.randomInt(0, 10 ** CODE_LENGTH);
  return String(n).padStart(CODE_LENGTH, '0');
}

/** Deterministic, salted hash so plaintext codes are never stored. */
function hashCode(code, contact) {
  return crypto
    .createHash('sha256')
    .update(`${String(code).trim()}:${String(contact).trim().toLowerCase()}:${config.jwtSecret || ''}`)
    .digest('hex');
}

/** Constant-time comparison of a submitted code against a stored hash. */
function verifyCode(submittedCode, contact, storedHash) {
  if (!storedHash) return false;
  const candidate = hashCode(submittedCode, contact);
  const a = Buffer.from(candidate);
  const b = Buffer.from(storedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

/**
 * Kept as a named export because callers and tests use `otp.normalizePhone`.
 * The logic moved to lib/phone/e164.js, which is where the SMS sender can also
 * reach it: this module requires ringCentralSmsService, so the sender cannot
 * require back without a cycle. Sending a number this function could not parse
 * now yields '' rather than bare digits — a caller must fall back rather than
 * hand a provider something it will reject.
 */
const normalizePhone = toE164;

function getGmailTransport(creds) {
  const { user, pass } = resolveGmailCreds(creds);
  if (!user || !pass) return null;
  // Cache, but rebuild if the configured account changed.
  if (cachedGmailTransport && cachedGmailUser === user) return cachedGmailTransport;
  // Lazy-require so environments without the email channel needn't load it.
  const nodemailer = require('nodemailer');
  cachedGmailTransport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  cachedGmailUser = user;
  return cachedGmailTransport;
}

function isChannelConfigured(channel, creds) {
  if (channel === 'gmail') {
    const { user, pass } = resolveGmailCreds(creds);
    return Boolean(user && pass);
  }
  if (channel === 'ringcentral') {
    return Boolean(process.env.RC_CLIENT_ID && process.env.RC_CLIENT_SECRET && process.env.RC_JWT_TOKEN);
  }
  return false;
}

function contactTypeForChannel(channel) {
  return channel === 'ringcentral' ? 'phone' : 'email';
}

/**
 * Deliver a passcode over the chosen channel. Returns { ok, contact, reason }.
 * `contact` is the normalized destination actually used.
 */
async function sendCode(channel, rawContact, code, creds) {
  if (channel === 'gmail') {
    const contact = String(rawContact || '').trim();
    if (!isValidEmail(contact)) return { ok: false, reason: 'invalid_email' };
    const transport = getGmailTransport(creds);
    if (!transport) return { ok: false, reason: 'gmail_not_configured' };
    const { from } = resolveGmailCreds(creds);
    const text = `Your Wenze driver-raise verification code is ${code}. It expires in 10 minutes.`;
    await transport.sendMail({
      from,
      to: contact,
      subject: 'Your Wenze verification code',
      text,
      html: `<p>Your Wenze driver-raise verification code is <b>${code}</b>.</p>`
        + '<p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>',
    });
    return { ok: true, contact };
  }

  if (channel === 'ringcentral') {
    const contact = normalizePhone(rawContact);
    if (!contact) return { ok: false, reason: 'invalid_phone' };
    const result = await sendSms(
      contact,
      `Your Wenze driver-raise verification code is ${code}. It expires in 10 minutes.`
    );
    if (!result.ok) return { ok: false, reason: result.reason || 'sms_failed', detail: result.detail };
    return { ok: true, contact };
  }

  return { ok: false, reason: 'unknown_channel' };
}

module.exports = {
  CODE_LENGTH,
  generateCode,
  hashCode,
  verifyCode,
  isValidEmail,
  normalizePhone,
  isChannelConfigured,
  contactTypeForChannel,
  sendCode,
};
