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
const {
  parseDriverStatus, computeRoadBonus, wholeDaysBetween, DAYS_PER_WEEK,
} = require('./homeTimeConstants');
const { inferDriverType } = require('../lib/drivers/driverProfileParse');
const roadBonus = require('./roadBonusNotifierService');
const { noticeDriverIsHome, noticeDriverBackOnRoad } = require('./homeTime/managerNotices');

/**
 * Telling managers must never break the thing it is reporting on. A notice runs
 * behind this guard so a Telegram outage, a missing settings row or a broken
 * lookup can delay the news without leaving the driver's cycle half-applied —
 * which is precisely the failure mode that left 74 open cycles in production.
 */
async function tellManagers(what, run) {
  try {
    return await run();
  } catch (err) {
    console.warn(`[HOME-TIME] manager notice (${what}) failed:`, err.message);
    return null;
  }
}

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
async function applyStateTransition(
  telegram, group, {
    newState, eventAt, statusText = '', announce = true, resyncSince = false,
    detectedBy = 'driver_message', evidenceSummary = null,
  }
) {
  try {
    const settings = await ht.getHomeTimeSettings();
    // DISABLED and FAILED must be distinguishable. Both used to be `null`, and a
    // caller that falls back to a direct state write on `null` would then do
    // exactly the thing this function exists to prevent: move the flip-flop
    // without its cycle, on a transient database error. `{ disabled: true }` is
    // truthy with no `.transition`, so every existing caller keeps behaving.
    if (!settings || !settings.enabled) return { disabled: true, changed: false, transition: null };

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
    //
    // `resyncSince` exists for the screenshot import, and its absence was a
    // regression: a corrected screenshot saying "still on the road, but left on
    // the 3rd" carries the SAME state and a DIFFERENT date. The old direct
    // upsert wrote `state_since`; this branch does not, so the road clock and
    // every bonus computed from it would keep using the wrong start date while
    // the import cheerfully reported the row as updated.
    //
    // It is opt-in because the driver-message path must NOT have it: a repeated
    // "Status: Home" would otherwise reset the clock on every message.
    if (current.state === newState) {
      await ht.touchDriverHomeStatus({
        groupId: group.id,
        lastStatusText: text.slice(0, 500),
        lastStatusAt: eventAt,
      });
      let resynced = false;
      if (resyncSince && eventAt && String(eventAt) !== String(current.state_since)) {
        await ht.setDriverHomeState(group.id, { stateSince: eventAt });
        resynced = true;
      }
      return {
        changed: resynced, transition: null, newState, previousState: current.state, eventAt,
        resyncedSince: resynced,
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
      // Anything still open for this driver — on this chat or a previous one —
      // is closed FIRST, with the road start we are about to record as its
      // return: a road→home insert can only follow a road state, so that
      // moment IS the observed return (class-B evidence, seen from this side).
      // It is also what lets the one-open-stay-per-group index hold.
      await closeLingeringHomeStays(group, { returnToRoadIso: current.state_since });
      const historyRow = await ht.insertRoadHistory({
        groupId: group.id,
        driverName,
        unitNumber,
        roadStartedAt: current.state_since,
        homeArrivedAt: eventAt,
        daysOnRoad,
        exceededWeeks,
        bonusUsd,
        // Born already-claimed on a silent path. The notifier polls for
        // `bonus_usd > 0 AND bonus_posted_at IS NULL`, so claiming afterwards
        // leaves a window: insert succeeds, claim fails, and an import of last
        // quarter fires stale bonuses into a live group an hour later. One
        // statement has no such window.
        bonusPostedAt: announce ? null : new Date().toISOString(),
      });
      // When a COMPANY driver went over the road allowance, post ONE extra-week
      // bonus summary to the configured Extra Week / Road Bonus group (the total
      // extra weeks + total bonus for this completed leg). This replaces the old
      // week-by-week posting: nothing is posted while the driver is still out.
      // Idempotent + restart-safe via the leg's bonus_posted_at claim; the
      // roadBonusNotifierService poller re-posts if this send fails. `overLimit`
      // is gated on company_driver, so owner-operators never trigger a post.
      if (overLimit && announce) {
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
      // The managers are told the driver IS HOME — a different event from the
      // earlier "wants to go home", and keyed on the cycle this arrival opened
      // so a re-derived arrival never tags them twice. `announce: false` is the
      // silent screenshot-import path, which must not fire live notices for a
      // stay that ended weeks ago.
      if (announce) {
        await tellManagers('arrived_home', async () => {
          const known = await ht.getApprovedHomeTimeRequestForGroup(group.id).catch(() => null);
          return noticeDriverIsHome(telegram, {
            roadHistoryId: historyRow?.id || null,
            groupId: group.id,
            driverName,
            unitNumber,
            homeSince: eventAt,
            plannedReturn: known?.return_to_road_date || null,
            daysOnRoad,
            settings,
            detectedBy,
          });
        });
      }
    }
    // home → road: the clock simply starts, AND the open home stay is closed
    // HERE rather than by the caller.
    //
    // This used to be delegated — "closed by the caller via closeHomeStayOnReturn"
    // — and that seam is what produced 74 open cycles out of 79 in production.
    // Two of the four paths that move this flip-flop never made that call: the
    // admin state flip and the screenshot import. The state moved, the cycle
    // stayed open forever, and nothing swept for the leftovers. A rule that
    // every caller must remember is a rule that some caller will forget, so the
    // function that moves the state now owns both halves of the transition.
    if (previousState === 'home' && newState === 'road') {
      const closed = await closeHomeStayOnReturn(group, { returnToRoadIso: eventAt });
      if (announce) {
        await tellManagers('back_on_road', async () => {
          const { driverName, unitNumber } = await resolveDriverLabel(group);
          return noticeDriverBackOnRoad(telegram, {
          // Keyed on the cycle that just closed. When no cycle was open (the
          // state was first observed as 'home', so there is nothing to close)
          // the key falls back to this group and this moment, which is still
          // one key per event rather than one per background check.
            roadHistoryId: closed?.id || null,
            eventKeySuffix: closed?.id ? null : `${group.id}:${eventAt}`,
            groupId: group.id,
            driverName,
            unitNumber,
            endedAt: eventAt,
            homeDays: closed?.home_days ?? null,
            evidenceSummary,
            settings,
            detectedBy,
          });
        });
      }
    }

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
async function closeOneStay(group, open, returnToRoadIso) {
  const homeDays = wholeDaysBetween(open.home_arrived_at, returnToRoadIso);
  let linkedRequestId = open.linked_request_id || null;
  if (!linkedRequestId) {
    const homeArrivedDate = DateTime.fromJSDate(new Date(open.home_arrived_at)).toISODate();
    // The request is looked up on the chat the stay BEGAN on — that is where it
    // was asked and decided, even when the return is observed on a new chat.
    const decided = await ht.findDecidedRequestNearDate(open.group_id || group.id, homeArrivedDate).catch(() => null);
    if (decided) linkedRequestId = decided.id;
  }
  return ht.closeHomeStay(open.id, { returnToRoadAt: returnToRoadIso, homeDays, linkedRequestId });
}

/** Every open stay of this driver, on any of their chats, closed at one observed moment. Best effort. */
async function closeLingeringHomeStays(group, { returnToRoadIso } = {}) {
  try {
    const open = await ht.listOpenHomeStays(group.id);
    let closed = 0;
    for (const stay of open) {
      if (!stay.home_arrived_at) continue;
      if (await closeOneStay(group, stay, returnToRoadIso)) closed += 1;
    }
    return closed;
  } catch (err) {
    console.error('[HOME-TIME] closeLingeringHomeStays error:', err.message);
    return 0;
  }
}

async function closeHomeStayOnReturn(group, { returnToRoadIso } = {}) {
  try {
    if (!group || !returnToRoadIso) return null;
    // Newest open stay of this DRIVER — the person's, not only the chat's, so a
    // return observed on a new truck's chat closes the stay begun on the old one.
    const [open] = await ht.listOpenHomeStays(group.id);
    let closed = null;
    if (open && open.home_arrived_at) {
      closed = await closeOneStay(group, open, returnToRoadIso);
    }
    // The home window is over → retire any clarification still waiting on dates and
    // stop its reminders (spec §11: stop when the driver returns to the road) —
    // on this chat, and on the chat the stay BEGAN on when that was another one:
    // the question was asked there, and it is as finished as one asked here.
    const chats = new Set([group.id]);
    if (open?.group_id != null) chats.add(open.group_id);
    for (const chatId of chats) {
      await ht.expireOpenClarificationsForGroup(chatId, {
        reason: 'Driver returned to the road; clarification no longer needed.',
      }).catch(() => {});
    }
    // The CLOSED row, so the caller can report the measured days at home. Falls
    // back to the pre-close row when the close itself found nothing to update.
    return closed || open || null;
  } catch (err) {
    console.error('[HOME-TIME] closeHomeStayOnReturn error:', err.message);
    return null;
  }
}

module.exports = {
  handleDriverGroupStatus,
  applyStateTransition,
  closeHomeStayOnReturn,
  closeLingeringHomeStays,
  messageTimestampIso,
};
