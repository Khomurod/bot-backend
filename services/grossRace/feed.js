'use strict';

/**
 * The Gross Grand Prix feed: this week's Datatruck loads, held in memory and
 * shared by every screen showing /dispatch or /dispatchteam.
 *
 * WHY ON THE SERVER. The race display as designed called Datatruck from the
 * browser with the company's API token written into the page. The token stays
 * here instead (DATATRUCK_API_TOKEN, the one the rest of the app uses), and
 * the screens read the standings from GET /api/gross-race.
 *
 * WHAT IT COSTS DATATRUCK. Its API allows 20 requests a minute at 25 orders a
 * page, and the rest of the app uses it too. So, as the design did:
 *   - the whole week (about five pages) is read at most every 20 minutes;
 *   - in between, only the orders modified since the last read, usually one
 *     page;
 *   - at most one read a minute however many screens poll, and none while no
 *     screen is open: a read starts only when a screen asks.
 * A screen never waits on Datatruck: it gets what is held now, and the read
 * finishes in the background. Nothing here touches the database.
 */

const datatruck = require('../datatruckApiService');
const { raceWeek } = require('./week');
const { raceLoad, standings, SOLO_TARGET, TEAM_TARGET } = require('./standings');

const REFRESH_MS = 60_000;
const FULL_EVERY_MS = 20 * 60_000;
// Datatruck's modified_datetime and this server's clock are not the same
// clock; re-reading a few minutes back costs one page and misses nothing.
const MODIFIED_OVERLAP_MS = 3 * 60_000;
const TZ = 'America/Chicago';

/** What a screen may be told about a failed read: fixed phrases, never the error. */
function describeFailure(err) {
  const status = err?.status;
  if (status === 401 || status === 403) return 'Datatruck rejected the token';
  if (status === 429) return 'Datatruck rate limit reached, retrying';
  if (status) return `Datatruck error (HTTP ${status})`;
  return 'No connection to Datatruck';
}

function createGrossRaceFeed({
  api = datatruck, now = () => Date.now(), log = console,
  refreshMs = REFRESH_MS, fullEveryMs = FULL_EVERY_MS,
} = {}) {
  // weekKey: which week `loads` belongs to. readAt: when the last successful
  // read STARTED, the base of the next incremental one. attemptAt: when any
  // read last started, which paces them.
  let held = { weekKey: null, loads: new Map(), readAt: 0, fullAt: 0, attemptAt: 0, updatedAt: null, error: null };
  let inFlight = null;

  async function read(startedAt) {
    const week = raceWeek({ tz: TZ, now: new Date(startedAt) });
    const weekKey = week.start.toISOString();
    const full = held.weekKey !== weekKey || startedAt - held.fullAt >= fullEveryMs;
    const modifiedAfterIso = full ? null : new Date(held.readAt - MODIFIED_OVERLAP_MS).toISOString();
    const orders = await api.fetchOrdersByDeliveryDate(
      week.start.toISOString(), new Date(week.end.getTime() - 1).toISOString(), { modifiedAfterIso },
    );
    const loads = full ? new Map() : new Map(held.loads);
    for (const order of orders) {
      if (order?.id == null) continue;
      const load = raceLoad(order);
      if (load) loads.set(order.id, load);
      else loads.delete(order.id);
    }
    held = {
      ...held, weekKey, loads, readAt: startedAt, fullAt: full ? startedAt : held.fullAt,
      updatedAt: new Date(startedAt), error: null,
    };
  }

  function refresh() {
    if (inFlight) return inFlight;
    const startedAt = now();
    held = { ...held, attemptAt: startedAt };
    inFlight = read(startedAt)
      .catch((err) => {
        held = { ...held, error: describeFailure(err) };
        log.warn('[GROSS-RACE] Datatruck read failed:', api.maskToken(err?.message || String(err)));
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  /** The race for one display, as it stands now. Starts a read when one is due. */
  function getRace(view) {
    const at = now();
    const week = raceWeek({ tz: TZ, now: new Date(at) });
    const weekKey = week.start.toISOString();
    if (!api.isConfigured()) {
      return shape({ view, week, status: 'error', error: 'Datatruck is not connected', race: null });
    }
    if (!held.attemptAt || at - held.attemptAt >= refreshMs || held.weekKey !== weekKey) {
      if (!inFlight) refresh();
    }
    if (held.weekKey !== weekKey) {
      return shape({ view, week, status: held.error ? 'error' : 'loading', error: held.error, race: null });
    }
    const loads = [...held.loads.values()].filter((load) => load.at >= week.start && load.at < week.end);
    return shape({
      view, week, status: held.error ? 'stale' : 'live', error: held.error,
      updatedAt: held.updatedAt, race: standings(loads, { view }),
    });
  }

  /** For tests: resolves when the read in flight, if any, has settled. */
  function settled() { return inFlight || Promise.resolve(); }

  return { getRace, settled };
}

function shape({ view, week, status, error = null, updatedAt = null, race }) {
  return {
    view,
    status,
    error,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    week: {
      start: week.start.toISOString(), end: week.end.toISOString(),
      label: week.label, day: week.day, dayName: week.dayName, tz: week.tz,
    },
    targets: view === 'teams' ? { solo: SOLO_TARGET, team: TEAM_TARGET } : null,
    race,
  };
}

module.exports = { createGrossRaceFeed, describeFailure };
