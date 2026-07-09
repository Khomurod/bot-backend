/**
 * Small Telegram text helpers shared by the bot's handler + sender modules.
 */

// HTML escape helper to prevent injection in Telegram messages
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Helper: get translation for a language ───
function getTranslation(translations, lang, fallback = 'en') {
  if (!translations || !Array.isArray(translations)) return null;
  const found = translations.find((t) => t.language === lang);
  if (found) return found;
  return translations.find((t) => t.language === fallback) || translations[0];
}

module.exports = { escapeHtml, getTranslation };
