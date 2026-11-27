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
 *
 * The 🏠🎉 "<driver> is home!" recognition post to the EMPLOYEE group was
 * removed at the owner's request (2026-10-06) — see docs/ARCHIVED_FEATURES.md.
 *
 * No timers or scheduler here: the settings row is seeded by schema.sql, so
 * there is no startup step either.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const ht = require('../database/homeTime');
const { parseDriverStatus, computeRoadBonus } = require('./homeTimeConstants');
const { inferDriverType } = require('../lib/drivers/driverProfileParse');
const { noticeDriverIsHome, noticeDriverBackOnRoad } = require('./homeTime/managerNotices');
const { closeHomeStayOnReturn, closeLingeringHomeStays } = require('./homeTime/stayClose');
const { reopenIfBriefRoad, foldNoticeLine, isoOf } = require('./homeTime/briefVisits');

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

/** When the state last actually changed: `state_changed_at`, or `state_since` before that column. */
function lastChangeOf(current) {
  const since = Date.parse(current?.state_since);
  const changed = Date.parse(current?.state_changed_at);
  if (Number.isFinite(changed) && (!Number.isFinite(since) || changed > since)) return current.state_changed_at;
  return current?.state_since;
}

/**
 * road → home. Records the finished trip and its bonus, or — when the driver
 * left a home stay only hours ago — reopens that stay instead.
 *
 * @returns {Promise<string>} where the home clock starts
 */
async function recordArrival(telegram, group, current, {
  settings, eventAt, announce, detectedBy, evidenceSummary,
}) {
  const reopened = await reopenIfBriefRoad(group, current, eventAt);
  if (reopened) {
    // ONE STAY, NOT TWO. No trip is recorded and no bonus computed: the hours
    // on the road were not a trip. The managers, told a few hours ago that the
    // driver left, are told they are home again — under a key of its own, so
    // the first arrival's notice does not swallow it.
    if (announce) {
      await tellManagers('arrived_home_again', async () => {
        const { driverName, unitNumber } = await resolveDriverLabel(group);
        return noticeDriverIsHome(telegram, {
          roadHistoryId: reopened.id,
          againAt: eventAt,
          groupId: group.id,
          driverName,
          unitNumber,
          homeSince: reopened.home_arrived_at,
          briefNote: reopened.reopened_note || null,
          settings,
          detectedBy,
        });
      });
    }
    return isoOf(reopened.home_arrived_at) || eventAt;
  }

  // Road trip just finished — close it and compute the bonus.
  const { driverName, unitNumber, driverType } = await resolveDriverLabel(group);
  const { daysOnRoad, exceededWeeks, bonusUsd } = computeRoadBonus(
    current.state_since,
    eventAt,
    {
      roadAllowanceWeeks: settings.road_allowance_weeks,
      bonusPerWeek: Number(settings.bonus_per_week),
      driverType,
    }
  );
  // Anything still open for this driver — on this chat or a previous one —
  // is closed FIRST, at the moment the road state began: a road→home insert
  // can only follow a road state, so that moment IS the observed return
  // (class-B evidence, seen from this side). After a folded brief visit
  // that is the fold, not the trip's start, which may be weeks earlier.
  // It is also what lets the one-open-stay-per-group index hold.
  await closeLingeringHomeStays(group, {
    returnToRoadIso: lastChangeOf(current),
    // NOT this transition's source. What closes these stays is the fact
    // that a road period was observed AFTER them — the evidence is the
    // road start itself, seen from the far side, and saying otherwise
    // would credit the wrong observer.
    closedBy: 'evidence',
    closedEvidence: 'a later road period was observed, so this stay had ended',
  });
  const historyRow = await ht.insertRoadHistory({
    groupId: group.id,
    driverName,
    unitNumber,
    roadStartedAt: current.state_since,
    homeArrivedAt: eventAt,
    daysOnRoad,
    exceededWeeks,
    bonusUsd,
    // WHO SAID THE DRIVER CAME HOME, and what they said. A manager reading
    // "home 14 - 18 Sep" needs to be able to ask whether a person wrote it
    // or a spreadsheet did; a correction nobody can trace is a correction
    // nobody can argue with.
    openedBy: detectedBy || null,
    openedEvidence: evidenceSummary || null,
    // Born already-claimed on a silent path. The notifier polls for
    // `bonus_usd > 0 AND bonus_posted_at IS NULL`, so claiming afterwards
    // leaves a window: insert succeeds, claim fails, and an import of last
    // quarter fires stale bonuses into a live group an hour later. One
    // statement has no such window.
    bonusPostedAt: announce ? null : new Date().toISOString(),
    // NOT POSTED NOW. The bonus is decided after the home stay — home
    // longer than the allowance forfeits it, and a trip over six weeks is
    // held for a person (owner's rule, 2026-10-06) — so the road-bonus
    // poller decides and posts it once the driver is back on the road.
    // A silent import's leg is born claimed above and never decided.
    bonusDecision: bonusUsd > 0 && announce ? 'waiting_home_stay' : null,
  });
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
  return eventAt;
}

/**
 * home → road. Closes the open stay — or folds it into the road trip it
 * interrupted when it lasted under 12 hours — and tells the managers.
 *
 * @returns {Promise<string>} where the road clock starts
 */
async function recordReturn(telegram, group, {
  eventAt, announce, detectedBy, evidenceSummary, settings,
}) {
  const closed = await closeHomeStayOnReturn(group, {
    returnToRoadIso: eventAt,
    foldBrief: true,
    closedBy: detectedBy || null,
    closedEvidence: evidenceSummary || null,
  });
  const folded = Boolean(closed?.folded_at && closed.road_started_at);
  if (announce) {
    await tellManagers('back_on_road', async () => {
      const { driverName, unitNumber } = await resolveDriverLabel(group);
      return noticeDriverBackOnRoad(telegram, {
        // Keyed on the cycle that just closed. When no cycle was open (the
        // state was first observed as 'home', so there is nothing to close)
        // the key falls back to this group and this moment, which is still
        // one key per event rather than one per background check. A stay
        // that was reopened closes a second time, under a key of its own.
        roadHistoryId: closed?.id || null,
        eventKeySuffix: closed?.id ? null : `${group.id}:${eventAt}`,
        againAt: closed?.reopened_at || null,
        groupId: group.id,
        driverName,
        unitNumber,
        endedAt: eventAt,
        homeDays: closed?.home_days ?? null,
        briefNote: folded ? foldNoticeLine(closed) : null,
        evidenceSummary,
        settings,
        detectedBy,
      });
    });
  }
  return folded ? (isoOf(closed.road_started_at) || eventAt) : eventAt;
}

/**
 * Apply a home/road state change (from the deterministic status parser OR the AI
 * intent classifier) to a driver group: run the home/road state machine, record a
 * completed road leg and its bonus on road→home, and post the extra-week summary
 * when a company driver came home over the allowance.
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
    //
    // `stateSince` is where the new state's clock starts: this event, except
    // for a brief visit (lib/homeTime/briefVisits.js). A stay under 12 hours
    // is folded into the road trip it interrupted, so the road clock goes on
    // from the trip's start; a road segment under 12 hours reopens the stay
    // before it, so the home clock goes on from the first arrival. The moment
    // of the change itself is kept apart (`state_changed_at`): the Board
    // watch's anti-flapping rules are about the change, not the clock.
    let stateSince = eventAt;
    const transitionOpts = {
      settings, eventAt, announce, detectedBy, evidenceSummary,
    };
    if (current.state === 'road' && newState === 'home') {
      stateSince = await recordArrival(telegram, group, current, transitionOpts);
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
      stateSince = await recordReturn(telegram, group, transitionOpts);
    }

    // Every transition starts a fresh leg → reset the extra-week watermark so
    // the notifier re-counts from zero for the new road trip.
    await ht.upsertDriverHomeStatus({
      groupId: group.id,
      telegramGroupId: group.telegram_group_id,
      state: newState,
      stateSince,
      stateChangedAt: eventAt,
      lastStatusText: text.slice(0, 500),
      lastStatusAt: eventAt,
      roadBonusWeeksNotified: 0,
    });

    const transition = previousState === 'road' && newState === 'home'
      ? 'road_to_home'
      : (previousState === 'home' && newState === 'road' ? 'home_to_road' : null);
    return {
      changed: true, transition, newState, previousState, eventAt,
      ...(stateSince !== eventAt ? { stateSince } : {}),
    };
  } catch (err) {
    console.error('[HOME-TIME] applyStateTransition error:', err.message);
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
