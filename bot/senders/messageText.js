/**
 * Choosing the language a broadcast goes out in — pure functions.
 *
 * A driver group has its own language; `forceLanguage` overrides it when an
 * admin deliberately sends one language to everyone. Getting this wrong sends a
 * driver a message they cannot read, so the fallback chain is explicit:
 * forced language (if valid) -> the group's language -> English.
 *
 * Split out of bot/senders.js, which re-exports both.
 */
/** Pick localized message text; `forceLanguage` overrides per-group language when set. */
function pickBroadcastMessage(messages, messageText, group, forceLanguage) {
  const lang =
    forceLanguage && ['en', 'ru', 'uz'].includes(forceLanguage)
      ? forceLanguage
      : (group && group.language) || 'en';
  if (messages && typeof messages === 'object') {
    return messages[lang] || messages.en || messageText;
  }
  return messageText;
}

function effectiveLangForConfirmation(group, forceLanguage) {
  if (forceLanguage && ['en', 'ru', 'uz'].includes(forceLanguage)) return forceLanguage;
  return (group && group.language) || 'en';
}

module.exports = { pickBroadcastMessage, effectiveLangForConfirmation };
