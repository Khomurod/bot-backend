/**
 * Driver Home-Time Tracking service.
 *
 * Event-driven: the bot's group-message handler calls handleDriverGroupStatus()
 * for every message in a driver group. We look for "Status: Home / Ready /
 * Rolling" and keep a simple home/road state machine per driver group.
 *
 * The extra-week bonus is posted as ONE summary on the road→home transition —
 * never week-by-week while the driver is still out. On this transition we:
 *   - record the completed trip (with its computed bonus, for the admin/history)
 *   - reset the per-leg notification watermark
 *   - post the single extra-week bonus summary (total extra weeks + total bonus)
 *     to the configured Extra Week / Road Bonus group when a COMPANY driver came
 *     home over the allowance (via roadBonusNotifierService.postCompletedRoadLeg,
 *     idempotent + restart-safe; a background poller re-posts if the send fails)
 *   - post a recognition-only (no dollar amounts) message to the EMPLOYEE group
 *     for the same case — for morale visibility, not accounting.
 *
 * No timers or scheduler here: the settings row is seeded by schema.sql, so
 * there is no startup step either.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const ht = require('../database/homeTime');
const config = require('../config/config');
const { safeSend } = require('./telegramHtml');
const { parseDriverStatus, computeRoadBonus, DAYS_PER_WEEK } = require('./homeTimeConstants');
const { inferDriverType } = require('./driverProfileParse');
const roadBonus = require('./roadBonusNotifierService');

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Timestamp the status message was sent (Telegram seconds → ISO), or now. */
function messageTimestampIso(message) {
  const secs = Number(message?.date);
  if (Number.isFinite(secs) && secs > 0) {
    return DateTime.fromSeconds(secs).toUTC().toISO();
  }
  return DateTime.now().toUTC().toISO();
}

/** Best display name + unit for a driver group (falls back to the group name). */
async function resolveDriverLabel(group) {
  try {
    const profile = await db.getDriverProfileByGroupId(group.id);
    const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim();
    return {
      driverName: name || group.group_name || `Group ${group.id}`,
      unitNumber: profile?.unit_number || null,
      driverType: profile?.driver_type || inferDriverType(group.group_name || ''),
    };
  } catch (err) {
    return {
      driverName: group.group_name || `Group ${group.id}`,
      unitNumber: null,
      driverType: inferDriverType(group.group_name || ''),
    };
  }
}

/**
 * Recognition-only homecoming post to the EMPLOYEE group. No dollar amounts —
 * this is morale visibility, not accounting. Only sent when a driver came home
 * after exceeding the road allowance. Non-fatal on failure.
 */
async function postHomecomingRecognition(telegram, {
  driverName, unitNumber, daysOnRoad,
}) {
  const employeeGroupId = config.employeeGroupId;
  if (!employeeGroupId) return;
  const who = `${escapeHtml(driverName)}${unitNumber ? ` (Unit ${escapeHtml(unitNumber)})` : ''}`;
  const weeksOnRoad = Math.floor(Number(daysOnRoad) / DAYS_PER_WEEK);
  const weekLabel = weeksOnRoad === 1 ? 'week' : 'weeks';
  const text = `🏠🎉 <b>${who} is home!</b>\n`
    + `Off the road after <b>${weeksOnRoad} ${weekLabel}</b> (${daysOnRoad} days) of keeping us rolling.\n`
    + 'Thank you for the dedication out there — welcome back! 👏';
  try {
    await safeSend(() => telegram.sendMessage(employeeGroupId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  } catch (err) {
    // Non-fatal: the trip is already saved and visible in the admin panel.
    console.error('[HOME-TIME] Failed to post homecoming recognition:', err.message);
  }
}

/**
 * Process one driver-group message. Safe to call on every message — it is a
 * no-op unless the text contains a recognizable "Status:" line. Never throws.
 *
 * Returns transition metadata so the caller (bot pipeline) can trigger the
 * conversational side-effects of a real state change (unplanned-home clarification
 * on road→home, home-stay close on home→road) without re-deriving them:
 *   { changed, transition, newState, previousState, eventAt } | null
 * where transition ∈ 'first_observation' | 'road_to_home' | 'home_to_road' | null.
 *
 * @param {object} telegram  bot.telegram instance (passed in to avoid a require cycle)
 * @param {object} group     groups row (id, telegram_group_id, group_name, group_type)
 * @param {object} message   Telegram message
 */
async function handleDriverGroupStatus(telegram, group, message) {
  try {
    if (!group || group.group_type !== 'driver') return null;
    const text = message?.text || message?.caption || '';
    const newState = parseDriverStatus(text);
    if (!newState) return null; // not a status message — ignore

    const eventAt = messageTimestampIso(message);
    return await applyStateTransition(telegram, group, {
      newState, eventAt, statusText: text,
    });
  } catch (err) {
    console.error('[HOME-TIME] handleDriverGroupStatus error:', err.message);
    return null;
  }
}

/**
 * Apply a home/road state change (from the deterministic status parser OR the AI
 * intent classifier) to a driver group: run the home/road state machine, record a
 * completed road leg and its bonus on road→home, and post the extra-week summary +
 * homecoming recognition when a company driver came home over the allowance.
 *
 * Shared by handleDriverGroupStatus (exact "Status:" line) and the AI-detected
 * status path (non-exact phrasing like "uyda" / "домой приехал"). Never throws.
 *
 * @returns {{changed:boolean, transition:(string|null), newState:string,
 *   previousState:(string|null), eventAt:string} | null}
 */
async function applyStateTransition(telegram, group, { newState, eventAt, statusText = '' }) {
  try {
    const settings = await ht.getHomeTimeSettings();
    if (!settings || !settings.enabled) return null;

    const current = await ht.getDriverHomeStatus(group.id);
    const text = String(statusText || '');

    // First time we ever see this group: just record where it stands now. We do
    // not invent a bonus for a trip whose start we never observed.
    if (!current) {
      await ht.upsertDriverHomeStatus({
        groupId: group.id,
        telegramGroupId: group.telegram_group_id,
        state: newState,
        stateSince: eventAt,
        lastStatusText: text.slice(0, 500),
        lastStatusAt: eventAt,
        roadBonusWeeksNotified: 0,
      });
      return {
        changed: true, transition: 'first_observation', newState, previousState: null, eventAt,
      };
    }

    // Same state again (e.g. repeated "Status: Home") → just touch, no transition.
    if (current.state === newState) {
      await ht.touchDriverHomeStatus({
        groupId: group.id,
        lastStatusText: text.slice(0, 500),
        lastStatusAt: eventAt,
      });
      return {
        changed: false, transition: null, newState, previousState: current.state, eventAt,
      };
    }

    const previousState = current.state;
    // ── A real transition ──
    if (current.state === 'road' && newState === 'home') {
      // Road trip just finished — close it and compute the bonus.
      const { driverName, unitNumber, driverType } = await resolveDriverLabel(group);
      const { daysOnRoad, exceededWeeks, bonusUsd, overLimit } = computeRoadBonus(
        current.state_since,
        eventAt,
        {
          roadAllowanceWeeks: settings.road_allowance_weeks,
          bonusPerWeek: Number(settings.bonus_per_week),
          driverType,
        }
      );
      const historyRow = await ht.insertRoadHistory({
        groupId: group.id,
        driverName,
        unitNumber,
        roadStartedAt: current.state_since,
        homeArrivedAt: eventAt,
        daysOnRoad,
        exceededWeeks,
        bonusUsd,
      });
      // When a COMPANY driver went over the road allowance, post ONE extra-week
      // bonus summary to the configured Extra Week / Road Bonus group (the total
      // extra weeks + total bonus for this completed leg). This replaces the old
      // week-by-week posting: nothing is posted while the driver is still out.
      // Idempotent + restart-safe via the leg's bonus_posted_at claim; the
      // roadBonusNotifierService poller re-posts if this send fails. `overLimit`
      // is gated on company_driver, so owner-operators never trigger a post.
      if (overLimit) {
        try {
          await roadBonus.postCompletedRoadLeg(
            telegram,
            { ...historyRow, driver_type: driverType, group_name: group.group_name },
            { allowanceWeeks: settings.road_allowance_weeks }
          );
        } catch (err) {
          console.error('[HOME-TIME] Road bonus summary post failed (poller will retry):', err.message);
        }
        // Recognition-only morale post to the EMPLOYEE group (no dollar amounts).
        await postHomecomingRecognition(telegram, { driverName, unitNumber, daysOnRoad });
      }
      console.log(`[HOME-TIME] ${driverName} (${driverType}) home after ${daysOnRoad}d (${exceededWeeks} extra wk, $${bonusUsd} recorded)`);
    }
    // home → road needs no calculation; the clock simply starts. The completed
    // home stay (return-to-road time + home duration) is closed by the caller via
    // closeHomeStayOnReturn so the home-time efficiency dashboard has real data.

    // Every transition starts a fresh leg → reset the extra-week watermark so
    // the notifier re-counts from zero for the new road trip.
    await ht.upsertDriverHomeStatus({
      groupId: group.id,
      telegramGroupId: group.telegram_group_id,
      state: newState,
      stateSince: eventAt,
      lastStatusText: text.slice(0, 500),
      lastStatusAt: eventAt,
      roadBonusWeeksNotified: 0,
    });

    const transition = previousState === 'road' && newState === 'home'
      ? 'road_to_home'
      : (previousState === 'home' && newState === 'road' ? 'home_to_road' : null);
    return {
      changed: true, transition, newState, previousState, eventAt,
    };
  } catch (err) {
    console.error('[HOME-TIME] applyStateTransition error:', err.message);
    return null;
  }
}

/**
 * Close the open home stay when a driver goes back on the road (home→road). Stamps
 * the actual return-to-road time and whole home days onto the still-open completed
 * road leg, links the decided home-time request that authorized it (for the
 * approved-exception classification), and retires any open clarification flow for
 * the group. Best-effort — the state machine already ran; never throws.
 *
 * @param {object} group    groups row
 * @param {object} opts
 * @param {string} opts.returnToRoadIso  the home→road transition time (ISO)
 * @returns {object|null} the closed road-history row, or null
 */
async function closeHomeStayOnReturn(group, { returnToRoadIso } = {}) {
  try {
    if (!group || !returnToRoadIso) return null;
    const open = await ht.getOpenHomeStay(group.id);
    if (open && open.home_arrived_at) {
      const homeDays = wholeDaysBetween(open.home_arrived_at, returnToRoadIso);
      let linkedRequestId = open.linked_request_id || null;
      if (!linkedRequestId) {
        const homeArrivedDate = DateTime.fromJSDate(new Date(open.home_arrived_at)).toISODate();
        const decided = await ht.findDecidedRequestNearDate(group.id, homeArrivedDate).catch(() => null);
        if (decided) linkedRequestId = decided.id;
      }
      await ht.closeHomeStay(open.id, { returnToRoadAt: returnToRoadIso, homeDays, linkedRequestId });
    }
    // The home window is over → retire any clarification still waiting on dates and
    // stop its reminders (spec §11: stop when the driver returns to the road).
    await ht.expireOpenClarificationsForGroup(group.id, {
      reason: 'Driver returned to the road; clarification no longer needed.',
    }).catch(() => {});
    return open || null;
  } catch (err) {
    console.error('[HOME-TIME] closeHomeStayOnReturn error:', err.message);
    return null;
  }
}

module.exports = {
  handleDriverGroupStatus,
  applyStateTransition,
  closeHomeStayOnReturn,
  messageTimestampIso,
};
