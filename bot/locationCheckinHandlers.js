/**
 * RETIRED: driver location check-in prompts.
 *
 * The pickup/delivery "Location Monitor" feature — which sent driver groups a
 * message with ✅ Checked In / 🚪 Checked Out buttons when the truck reached a
 * shipper/receiver — has been retired (it malfunctioned and irritated drivers).
 * See docs/architecture/retired-checkin-checkout-feature.md.
 *
 * The poller that produced those prompts (services/driverLocationMonitorService.js)
 * has been removed, so no new prompts are ever generated. This file remains only
 * as a safe stub: if a driver taps an OLD button on an OLD message, the callback
 * (`loccheck:in:<id>` / `loccheck:out:<id>`) is answered gracefully instead of
 * being ignored or crashing the bot. It performs no database work and creates no
 * new state.
 */

const RETIRED_MESSAGE = 'This check-in/check-out feature has been retired.';

/**
 * Registers a no-op handler for the legacy check-in callbacks. Kept so bot.js
 * wiring is unchanged and stale buttons stay harmless.
 */
function registerLocationCheckinHandlers(bot) {
  // Broad matcher: catches every legacy loccheck:* callback (in/out, any id).
  bot.action(/^loccheck:/, async (ctx) => {
    try {
      await ctx.answerCbQuery(RETIRED_MESSAGE, { show_alert: true });
    } catch (_) {
      // Never let a stale button click surface as an unhandled rejection.
    }
  });

  console.log('[LOCATION-MONITOR] Retired: legacy check-in buttons answered with a retirement notice.');
}

module.exports = { registerLocationCheckinHandlers, RETIRED_MESSAGE };
