/**
 * Dispatcher group command: /location (live truck location).
 *
 * Moved verbatim from bot/bot.js. /load, /update and /status lived here too
 * until the owner removed the dispatcher ETA feature and the pinned-load
 * reading on 23 October 2026 — see docs/architecture/retired-dispatch-eta.md.
 * Loads are read from the Dispatcher Board and Datatruck now; /location reads
 * only the telematics providers and never needed the load.
 */
const { resolveLiveLocationForGroupTitle } = require('../../services/liveLocationResolver');
const {
  buildLocationSummaryLines,
  buildStrictMismatchBlockMessage,
  isLocationDriverNameStrict,
} = require('../../lib/drivers/driverGroupTitle');

function registerDispatchCommands(bot) {
  // Dispatcher helper: post live truck location for this group's unit number.
  bot.command('location', async (ctx) => {
    try {
      const chatType = ctx.chat?.type;
      if (chatType !== 'group' && chatType !== 'supergroup') {
        await ctx.reply('Use /location inside a driver group chat.');
        return;
      }

      const groupTitle = ctx.chat?.title || '';
      let resolved = null;
      try {
        resolved = await resolveLiveLocationForGroupTitle(groupTitle);
      } catch (err) {
        if (err.code === 'UNIT_NOT_FOUND_IN_GROUP_TITLE') {
          await ctx.reply('Could not find a unit number in this group title.');
          return;
        }
        if (err.code === 'AMBIGUOUS_UNIT_MATCH') {
          const who = err.assignedDriverName ? ` for this driver (${err.assignedDriverName})` : '';
          const candidates = Array.isArray(err.candidates) && err.candidates.length
            ? `\nVehicles sharing unit ${err.unitNumber}: ${err.candidates.join(', ')}.` : '';
          await ctx.reply(
            `⚠️ Multiple trucks share unit ${err.unitNumber} and I can't tell which one is this truck${who}. `
            + 'To avoid sending the wrong location I did not post one.'
            + candidates
            + '\nPlease fix the duplicate unit number, or rename the vehicle in Samsara to match the driver.'
          );
          return;
        }
        console.error('[BOT] /location provider chain failed:', err.message);
        await ctx.reply('Could not fetch live location from Samsara, Factor ELD, or Leader ELD right now.');
        return;
      }
      const { location, source } = resolved;

      if (location.driverNameMismatch && isLocationDriverNameStrict()) {
        await ctx.reply(buildStrictMismatchBlockMessage(location));
        return;
      }

      await ctx.replyWithLocation(location.latitude, location.longitude);
      await ctx.reply(buildLocationSummaryLines({ location, source }).join('\n'));
    } catch (err) {
      console.error('[BOT] /location failed:', err.message);
      await ctx.reply('Could not fetch live location right now. Please try again in a minute.');
    }
  });
}

module.exports = { registerDispatchCommands };
