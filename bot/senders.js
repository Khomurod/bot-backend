/**
 * Outbound send family — factory façade.
 *
 * bot.js hands in its Telegraf instance and the LIVE db/config module objects.
 * Those must stay the same references: tests patch properties on them, so
 * copying or destructuring their contents here would break that seam.
 *
 * Composed from focused sub-factories, wired in dependency order because each
 * later family sends its media through the shared sender:
 *
 *   ./senders/messageText.js          PURE language selection for a group
 *   ./senders/mediaSender.js          the one media path + strict templating
 *   ./senders/questionSenders.js      survey questions + management preview
 *   ./senders/broadcastSenders.js     broadcasts, subsets, and the test send
 *   ./senders/confirmationSenders.js  broadcasts that ask for a tap back
 *
 * Every family shares one rule: a PERMANENT send error deactivates the group,
 * a transient one backs off, and a successful send is never turned back into a
 * retry (APP_BRIEF §7 — that is how a driver gets the same message twice).
 */
const {
  pickBroadcastMessage,
  effectiveLangForConfirmation,
} = require('./senders/messageText');
const { createMediaSender } = require('./senders/mediaSender');
const { createQuestionSenders } = require('./senders/questionSenders');
const { createBroadcastSenders } = require('./senders/broadcastSenders');
const { createConfirmationSenders } = require('./senders/confirmationSenders');

function createBotSenders({ bot, db, config }) {
  const { resolveRenderedBroadcastText, sendMedia } = createMediaSender({ bot, db, config });
  const shared = { bot, db, config, sendMedia, resolveRenderedBroadcastText };

  const { sendQuestionToGroups, sendTestQuestion } = createQuestionSenders({
    bot, db, config, sendMedia,
  });
  const {
    sendBroadcast, sendBroadcastTest, sendBroadcastToGroups,
  } = createBroadcastSenders(shared);
  const {
    sendConfirmationBroadcast, sendConfirmationBroadcastTest,
  } = createConfirmationSenders(shared);

  return {
    sendMedia,
    sendQuestionToGroups,
    sendTestQuestion,
    sendBroadcast,
    sendBroadcastTest,
    sendBroadcastToGroups,
    sendConfirmationBroadcast,
    sendConfirmationBroadcastTest,
  };
}

module.exports = { createBotSenders, pickBroadcastMessage, effectiveLangForConfirmation };
