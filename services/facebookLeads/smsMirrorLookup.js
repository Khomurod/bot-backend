'use strict';

/**
 * Finding the mirror row a Telegram message belongs to, and the small text
 * helpers both directions of the mirror need.
 *
 * Split out of services/facebookLeadSmsMirrorService.js so that the outbound
 * half (posting a notice) and the inbound half (relaying a reply) can each
 * require it without requiring each other. It is the bottom of that little
 * three-file stack and depends on nothing above the database.
 */
const db = require('../../database/db');

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function candidateTelegramChatIds(chatId) {
  const raw = String(chatId).trim();
  const candidates = new Set();
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) candidates.add(asNum);

  if (raw.startsWith('-100')) {
    const abs = raw.slice(4);
    const legacy = Number(`-${abs}`);
    if (Number.isFinite(legacy)) candidates.add(legacy);
  } else if (raw.startsWith('-')) {
    const abs = raw.slice(1);
    const supergroup = Number(`-100${abs}`);
    if (Number.isFinite(supergroup)) candidates.add(supergroup);
  }

  return [...candidates];
}

/** "Jane Doe (+14704804679)", "+14704804679", or '' when nothing is known. */
function describeSender(sender) {
  const name = String(sender?.name || '').trim();
  const number = String(sender?.fromNumber || '').trim();
  if (name && number) return `${name} (${number})`;
  return name || number || '';
}

async function findMirrorByTelegramMessage(telegramChatId, telegramMessageId) {
  for (const chatId of candidateTelegramChatIds(telegramChatId)) {
    const row = await db.getFacebookLeadSmsMirror(chatId, telegramMessageId);
    if (row) return row;
  }
  return null;
}

module.exports = {
  escapeHtml,
  candidateTelegramChatIds,
  describeSender,
  findMirrorByTelegramMessage,
};
