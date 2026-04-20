function buildTelegramMessageUrl(telegramGroupId, telegramMessageId) {
  const chatId = String(telegramGroupId || '');
  const msgId = Number(telegramMessageId);
  if (!chatId.startsWith('-100') || !Number.isInteger(msgId) || msgId <= 0) return null;
  const trimmedChatId = chatId.slice(4);
  if (!trimmedChatId) return null;
  return `https://t.me/c/${trimmedChatId}/${msgId}`;
}

module.exports = {
  buildTelegramMessageUrl,
};
