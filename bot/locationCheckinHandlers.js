/**
 * Inline-button handlers for driver location check-in prompts.
 *
 * When the location monitor detects a truck within the check-in radius of its
 * shipper/receiver, it posts a "report your status" message with
 * Checked In / Checked Out buttons (callback data `loccheck:in:<id>` /
 * `loccheck:out:<id>`). Both are terminal answers for that stop: the driver's
 * response is recorded here (along with whether they were on time), and the
 * stop is never prompted again. The monitor then advances to the next stop.
 *
 * Kept free of any require on the monitor *service* to avoid a circular
 * dependency (the service is started from index.js and never imports the bot).
 */
const monitorsDb = require('../database/driverLocationMonitors');

// Counted on-time if the driver reaches/answers within this grace of the
// appointment (kept in sync with driverLocationMonitorService.APPOINTMENT_GRACE_MIN).
const APPOINTMENT_GRACE_MIN = 15;
const ADVANCE_AFTER_ANSWER_MIN = 3;

// Map the two inline buttons to their stored terminal response values.
const RESPONSE_BY_ACTION = { in: 'checked_in', out: 'checked_out' };

function minutesFromNowIso(minutes) {
  return new Date(Date.now() + Math.max(0, Number(minutes) || 0) * 60_000).toISOString();
}

/**
 * On-time = the driver reached/answered at the stop no later than the
 * appointment (plus a short grace). Null when no appointment is known.
 */
function computeOnTime(appointmentAt, nowMs = Date.now()) {
  if (!appointmentAt) return null;
  const apptMs = Date.parse(String(appointmentAt));
  if (!Number.isFinite(apptMs)) return null;
  const grace = APPOINTMENT_GRACE_MIN * 60_000;
  return nowMs <= apptMs + grace;
}

function registerLocationCheckinHandlers(bot) {
  bot.action(/^loccheck:(in|out):(\d+)$/, async (ctx) => {
    try {
      const action = ctx.match[1];
      const answer = RESPONSE_BY_ACTION[action] || 'checked_in';
      const checkinId = parseInt(ctx.match[2], 10);
      const from = ctx.from || {};

      const checkin = await monitorsDb.getCheckinById(checkinId);
      if (!checkin) {
        await ctx.answerCbQuery('This check-in is no longer available.');
        return;
      }

      // Only accept the answer on the current prompt message in its own group.
      const callbackChatId = ctx.callbackQuery?.message?.chat?.id;
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;
      const isCurrentPrompt = String(callbackChatId) === String(checkin.telegram_group_id)
        && (checkin.prompt_message_id == null
          || String(callbackMessageId) === String(checkin.prompt_message_id));
      if (!isCurrentPrompt) {
        await ctx.answerCbQuery('This is an old check-in prompt.', { show_alert: true });
        return;
      }

      const onTime = computeOnTime(checkin.appointment_at);
      const { record, alreadyAnswered } = await monitorsDb.recordCheckinResponse(checkinId, {
        response: answer,
        username: from.username || null,
        userId: from.id || null,
        onTime,
      });

      if (!record) {
        await ctx.answerCbQuery('This check-in is no longer available.');
        return;
      }
      if (alreadyAnswered) {
        const by = record.responded_by_username ? `@${record.responded_by_username}` : 'someone';
        await ctx.answerCbQuery(`Already answered (${record.driver_response}) by ${by}.`);
        return;
      }

      const stopLabel = checkin.stop_type === 'shipper' ? 'shipper' : 'receiver';
      const punctuality = onTime === null ? '' : onTime ? ' • on time' : ' • late';
      const footer = answer === 'checked_in'
        ? `\n\n✅ Checked in at the ${stopLabel}${punctuality} — thank you!`
        : `\n\n🚪 Checked out at the ${stopLabel}${punctuality} — thank you!`;

      // Append the outcome to the original prompt and remove the buttons.
      const originalText = ctx.callbackQuery?.message?.text || '';
      try {
        await ctx.editMessageText(`${originalText}${footer}`);
      } catch (err) {
        // Fall back to just clearing the keyboard if the edit fails.
        try { await ctx.editMessageReplyMarkup(); } catch (_) { /* ignore */ }
      }

      await ctx.answerCbQuery(answer === 'checked_in' ? '✅ Recorded — thank you!' : '🚪 Recorded — thank you!');

      // Both answers are terminal for this stop. Clear the cached target so the
      // monitor advances to the next stop (pickup → delivery); it will never
      // re-prompt this stop (the one-prompt-per-stop guard blocks that).
      try {
        await monitorsDb.clearMonitorTarget(checkin.monitor_id, {
          nextRunAt: minutesFromNowIso(ADVANCE_AFTER_ANSWER_MIN),
          lastStatus: `${answer}_${stopLabel}`,
        });
      } catch (err) {
        console.warn('[LOCATION-MONITOR] Could not advance monitor after answer:', err.message);
      }

      console.log(
        `[LOCATION-MONITOR] Check-in ${checkinId} answered ${answer} `
        + `(${stopLabel}${onTime === null ? '' : onTime ? ', on time' : ', late'}) by `
        + `${from.username ? `@${from.username}` : from.id}`
      );
    } catch (err) {
      console.error('[LOCATION-MONITOR] Check-in callback error:', err.message);
      try { await ctx.answerCbQuery('An error occurred.'); } catch (_) { /* ignore */ }
    }
  });

  console.log('[LOCATION-MONITOR] Check-in handlers registered.');
}

module.exports = { registerLocationCheckinHandlers };
