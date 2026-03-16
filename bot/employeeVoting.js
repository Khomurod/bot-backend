/**
 * Employee Voting — Bot handlers (isolated from driver survey bot logic)
 */
const { Markup } = require('telegraf');
const config = require('../config/config');
const votingDb = require('../database/employeeVoting');

const EMPLOYEE_GROUP_ID = config.employeeGroupId;

/**
 * Register voting callback handlers on the bot instance.
 * Called once from bot.js during startup.
 */
function registerVotingHandlers(bot) {
  if (!EMPLOYEE_GROUP_ID) {
    console.log('[VOTING] EMPLOYEE_GROUP_ID not set — voting feature disabled.');
    return;
  }

  console.log(`[VOTING] Voting handlers registered for employee group: ${EMPLOYEE_GROUP_ID}`);

  // Handle vote_unit_* callbacks — registered via bot.action to avoid
  // conflicting with the existing callback_query handler in bot.js
  bot.action(/^vote_unit_(.+)$/, async (ctx) => {
    try {
      const unitNumber = ctx.match[1];
      const chatId = ctx.callbackQuery.message?.chat?.id;

      // Only accept votes from the employee group
      if (String(chatId) !== String(EMPLOYEE_GROUP_ID)) {
        await ctx.answerCbQuery('Voting is only allowed in the employee group.');
        return;
      }

      // Find active poll
      const poll = await votingDb.getActivePoll();
      if (!poll) {
        await ctx.answerCbQuery('No active poll. Voting is closed.');
        return;
      }

      // Find the option
      const option = await votingDb.getOptionByPollAndUnit(poll.id, unitNumber);
      if (!option) {
        await ctx.answerCbQuery('Invalid option.');
        return;
      }

      // Cast vote
      const result = await votingDb.castVote(
        poll.id,
        option.id,
        ctx.from.id,
        ctx.from.username || null,
        ctx.from.first_name || null,
        unitNumber
      );

      if (result.success) {
        await ctx.answerCbQuery(`✅ Vote recorded for Unit #${unitNumber}!`);
      } else {
        await ctx.answerCbQuery('❌ You have already voted.');
      }
    } catch (err) {
      console.error('[VOTING] Error handling vote callback:', err.message);
      try {
        await ctx.answerCbQuery('An error occurred. Please try again.');
      } catch (_) {}
    }
  });
}

/**
 * Send a voting poll to the employee group.
 * Returns the sent message for storing telegram_message_id.
 */
async function sendVotingPoll(bot, pollId, options) {
  if (!EMPLOYEE_GROUP_ID) throw new Error('EMPLOYEE_GROUP_ID not configured');

  const question = 'Choose the best driver of the week in your opinion.';

  // Build inline keyboard — 1 button per row
  const buttons = options.map(opt => [
    Markup.button.callback(`Unit #${opt.unit_number}`, `vote_unit_${opt.unit_number}`),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  const message = `🏆 <b>Driver of the Week</b>\n\n${question}\n\n<i>Tap a unit number below to cast your vote:</i>`;

  const sent = await bot.telegram.sendMessage(EMPLOYEE_GROUP_ID, message, {
    parse_mode: 'HTML',
    ...keyboard,
  });

  // Save the message ID back to the poll
  await votingDb.setPollMessageId(pollId, sent.message_id, EMPLOYEE_GROUP_ID);

  console.log(`[VOTING] Poll sent to employee group. message_id=${sent.message_id}`);
  return sent;
}

module.exports = { registerVotingHandlers, sendVotingPoll };
