/**
 * Standalone diagnostic: verify MANAGEMENT_GROUP_ID and that the bot can post.
 * Run from repo root: node scratch/test-management.js
 * Requires a valid .env (same as the main app).
 */
const { bot } = require('../bot/bot');
const config = require('../config/config');

function toSupergroupStyleChatId(chatId) {
  const s = String(chatId).trim();
  if (s.startsWith('-100')) return s;
  const abs = s.replace(/^-/, '');
  return `-100${abs}`;
}

function isChatNotFound(err) {
  const desc = (err?.response?.description || err?.message || '').toLowerCase();
  return err?.response?.error_code === 400 && desc.includes('chat not found');
}

(async () => {
  const primaryId = config.managementGroupId;
  console.log('[DIAG] Using MANAGEMENT_GROUP_ID from config:', primaryId);

  async function probe(chatId, label) {
    try {
      const chat = await bot.telegram.getChat(chatId);
      const title = chat.title || '(no title)';
      const type = chat.type || '?';
      console.log(`[DIAG] getChat OK (${label}): "${title}" · type=${type}`);
      await bot.telegram.sendMessage(chatId, 'Diagnostic Test');
      console.log(`[DIAG] sendMessage OK (${label}): posted "Diagnostic Test".`);
      return { ok: true };
    } catch (err) {
      return { ok: false, err };
    }
  }

  let first = await probe(primaryId, 'configured ID');
  if (first.ok) {
    console.log('[DIAG] Outcome: Success — your MANAGEMENT_GROUP_ID works and the bot can send messages.');
    process.exit(0);
  }

  const e0 = first.err;
  const code0 = e0?.response?.error_code;
  const desc0 = e0?.response?.description || e0?.message || '';

  if (!isChatNotFound(e0)) {
    console.error('[DIAG] getChat or sendMessage failed (no "chat not found" retry path):', code0, desc0);
    if (code0 === 403) {
      console.error('[DIAG] Likely cause: bot is not in the group, was removed, or lacks permission to post.');
    } else if (code0 === 400 && String(desc0).toLowerCase().includes('chat was upgraded')) {
      console.error('[DIAG] Likely cause: the group was upgraded to a supergroup — use the new -100… chat id in .env.');
    }
    process.exit(1);
  }

  const altId = toSupergroupStyleChatId(primaryId);
  console.warn(
    `[DIAG] "chat not found" for ${primaryId}. Retrying with supergroup-style id ${altId} (common after a supergroup upgrade).`
  );

  const second = await probe(altId, 'supergroup-style ID');
  if (second.ok) {
    console.warn(`[DIAG] Outcome: Works with ${altId}. Update your .env MANAGEMENT_GROUP_ID to that value.`);
    process.exit(0);
  }

  const e1 = second.err;
  console.error('[DIAG] Outcome: Failed with both ids.');
  console.error('  • Ensure the bot is added to the management group.');
  console.error('  • In supergroups, copy the correct chat id (often -100…).');
  console.error('  • Last error:', e1?.response?.description || e1?.message);
  process.exit(1);
})();
