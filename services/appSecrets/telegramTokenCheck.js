'use strict';

/**
 * Ask Telegram whether a bot token works — `getMe`, which changes nothing.
 *
 * Used by Settings → Secrets before a token is saved: a token Telegram refuses
 * would bring the app back up with a bot that cannot poll. The answer carries
 * the bot's @username (so the page can show WHICH bot a token belongs to) or a
 * short reason — never the token, which is also kept out of any error text.
 */
const { Telegram } = require('telegraf');
const { telegramClientOptions } = require('../telegramAgent');
const { redactSecret } = require('../../lib/security/redactSecret');

const TIMEOUT_MS = 10_000;

async function checkTelegramToken(token, { TelegramImpl = Telegram, timeoutMs = TIMEOUT_MS } = {}) {
  const value = String(token || '').trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(value)) return { ok: false, error: 'not the shape of a bot token' };
  let timer;
  try {
    const client = new TelegramImpl(value, telegramClientOptions);
    const me = await Promise.race([
      client.getMe(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer from Telegram')), timeoutMs); }),
    ]);
    return { ok: true, username: me && me.username ? `@${me.username}` : null };
  } catch (err) {
    const code = err && err.response && err.response.error_code;
    if (code === 401 || code === 404) return { ok: false, error: 'Telegram does not know this token' };
    return { ok: false, error: redactSecret(String((err && err.message) || 'check failed'), value).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkTelegramToken };
