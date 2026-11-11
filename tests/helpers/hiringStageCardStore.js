'use strict';

/**
 * database/hiringStages/cards.js in memory, with the same semantics: the name
 * is set once, a history line is appended, the question is replaced or
 * cleared, the message id recorded. `cards` is the live map, for assertions.
 */

function createCardStore() {
  const cards = new Map();
  const keyOf = (chatId, root) => `${chatId}:${Number(root)}`;
  const copy = (c) => (c ? { ...c, history: [...c.history] } : null);
  return {
    cards,
    all: () => [...cards.values()].map(copy),
    reset: () => cards.clear(),
    store: {
      getCard: async (chatId, root) => copy(cards.get(keyOf(chatId, root))),
      ensureCard: async (chatId, root, driverName) => {
        const key = keyOf(chatId, root);
        const card = cards.get(key) || {
          chatId: String(chatId), rootMessageId: Number(root), messageId: null, driverName: null,
          history: [], currentText: null, currentKeyboard: null,
        };
        card.driverName = card.driverName || driverName || null;
        cards.set(key, card);
        return copy(card);
      },
      updateCard: async (chatId, root, { line, current, messageId } = {}) => {
        const card = cards.get(keyOf(chatId, root));
        if (!card) return null;
        if (line) card.history.push(line);
        if (current !== undefined) {
          card.currentText = current?.text ?? null;
          card.currentKeyboard = current?.keyboard ?? null;
        }
        if (messageId) card.messageId = Number(messageId);
        return copy(card);
      },
      purgeOldCards: async () => 0,
    },
  };
}

module.exports = { createCardStore };
