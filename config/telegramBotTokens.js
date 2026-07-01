/**
 * Token aliases used across services.
 * Values come from environment variables only.
 */
require('dotenv').config();

module.exports = {
  feedbackBotToken: process.env.BOT_TOKEN || '',
  leadsBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
};
