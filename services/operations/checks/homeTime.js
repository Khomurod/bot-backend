/**
 * Home-Time checks — pure, no I/O.
 *
 * A cycle is a `driver_road_history` row, and "complete" means
 * `return_to_road_at IS NOT NULL`. That column has exactly one writer,
 * `closeHomeStay`, reachable only from a `home → road` transition detected in a
 * driver-group message — so an admin state flip or a screenshot import moves the
 * flip-flop WITHOUT closing anything, and nothing anywhere sweeps for the
 * leftovers. Production carries 74 open cycles out of 79.
 *
 * The valuable part of these checks is that most of those 74 are not a mystery:
 * the moment the driver went back on the road is already recorded, just not in
 * the column that marks the cycle closed. Two independent classes of evidence
 * cover 65 of them, and each is exact rather than inferred:
 *
 *   CLASS A — the group's current state is `road`, since a time after this
 *   cycle's `home_arrived_at`. That timestamp IS the observed return.
 *
 *   CLASS B — a LATER cycle exists for the same group. A `road → home` insert
 *   can only happen from the `road` state, so that later row's `road_started_at`
 *   is this cycle's return, seen from the other side.
 *
 * Anything with neither is left open and merely reported. A cycle whose driver is
 * genuinely still at home is not a defect.
 */

const DEFAULT_HOME_ALLOWANCE_DAYS = 4;
const DEFAULT_ROAD_ALLOWANCE_WEEKS = 4;
/** A day of slack so a driver who is a few hours over does not raise a finding. */
const GRACE_DAYS = 1;

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(from, to) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

function groupLabel(group, groupId) {
  return group?.group_name || `Group ${groupId}`;
}

/**
 * YYYY-MM-DD for a title.
 *
 * `pg` hands back a Date for a timestamp column, and `String(date)` on one reads
 * "Wed Jul 01 2026 …" — so slicing the raw value produced a title that said
 * "home stay from Wed Jul 01". Convert, then slice.
 */
function isoDay(value) {
  const d = toDate(value);
  return d ? d.toISOString().slice(0, 10) : 'an unknown date';
}

/** Cycles per group, oldest first — the order both evidence classes need. */
function cyclesByGroup(roadHistory) {
  const byGroup = new Map();
  for (const row of roadHistory) {
    if (!byGroup.has(row.group_id)) byGroup.set(row.group_id, []);
    byGroup.get(row.group_id).push(row);
  }
  for (const rows of byGroup.values()) {
    rows.sort((a, b) => new Date(a.home_arrived_at) - new Date(b.home_arrived_at));
  }
  return byGroup;
}

/**
 * Classify every open cycle by the evidence available for closing it.
 *
 * Exported because the Stage-6 repair batch and these findings must agree by
 * construction — one function decides, both use it.
 *
 * @returns {Array<{cycle, evidenceClass:'A'|'B'|'C'|'N', returnAt:Date|null, source:string}>}
 */
function classifyOpenCycles({ roadHistory = [], homeStatus = [] }) {
  const statusByGroup = new Map(homeStatus.map((s) => [s.group_id, s]));
  const byGroup = cyclesByGroup(roadHistory);
  const out = [];

  for (const [groupId, rows] of byGroup) {
    for (let i = 0; i < rows.length; i += 1) {
      const cycle = rows[i];
      if (cycle.return_to_road_at) continue;

      const arrived = toDate(cycle.home_arrived_at);
      const next = rows[i + 1];

      if (next) {
        // CLASS B — the next cycle's road start is this one's return.
        const roadStarted = toDate(next.road_started_at);
        if (roadStarted && arrived && roadStarted >= arrived) {
          out.push({
            cycle, evidenceClass: 'B', returnAt: roadStarted,
            source: `driver_road_history #${next.id}.road_started_at`,
          });
          continue;
        }
        out.push({ cycle, evidenceClass: 'N', returnAt: null, source: null });
        continue;
      }

      const status = statusByGroup.get(groupId);
      const stateSince = toDate(status?.state_since);
      if (status?.state === 'road' && stateSince && arrived && stateSince > arrived) {
        // CLASS A — an observed road transition after this cycle's home arrival.
        out.push({
          cycle, evidenceClass: 'A', returnAt: stateSince,
          source: 'driver_home_status.state_since',
        });
        continue;
      }
      if (status?.state === 'home') {
        // CLASS C — correctly open. The driver really is at home.
        out.push({ cycle, evidenceClass: 'C', returnAt: null, source: null });
        continue;
      }
      out.push({ cycle, evidenceClass: 'N', returnAt: null, source: null });
    }
  }
  return out;
}

/**
 * An open cycle whose return moment is already recorded.
 *
 * Tier `auto`: the value is not being invented, it is being copied from the row
 * that already holds it. `home_days` follows from the two stored timestamps.
 */
function checkClosableCycles({ roadHistory = [], homeStatus = [], groupsById = new Map() }) {
  return classifyOpenCycles({ roadHistory, homeStatus })
    .filter((c) => c.evidenceClass === 'A' || c.evidenceClass === 'B')
    .map(({ cycle, evidenceClass, returnAt, source }) => ({
      checkKey: 'home_time.closable_open_cycle',
      subjectType: 'road_history',
      subjectId: cycle.id,
      title: `${groupLabel(groupsById.get(cycle.group_id), cycle.group_id)}: home stay from `
        + `${isoDay(cycle.home_arrived_at)} can be closed from recorded evidence`,
      severity: 'info',
      tier: 'auto',
      confidence: evidenceClass === 'B' ? 95 : 90,
      evidence: {
        cycleId: cycle.id,
        groupId: cycle.group_id,
        evidenceClass,
        source,
        roadStartedAt: cycle.road_started_at,
        homeArrivedAt: cycle.home_arrived_at,
        observedReturnAt: returnAt,
        // Structurally unreachable rows: `getOpenHomeStay` takes the newest open
        // row only, so an older one can never be closed by normal operation.
        hiddenByLaterCycle: evidenceClass === 'B',
      },
      proposedChange: {
        table: 'driver_road_history',
        id: cycle.id,
        returnToRoadAt: { from: null, to: returnAt },
        homeDays: { from: cycle.home_days ?? null, to: daysBetween(cycle.home_arrived_at, returnAt) },
        // Deliberately absent: bonus_usd. It is computed at insert and closing a
        // cycle does not recompute it, so this repair is payout-neutral.
      },
    }));
}

/** A driver who has been home well past the configured allowance. */
function checkHomeStayPastAllowance({
  roadHistory = [], homeStatus = [], groupsById = new Map(), settings = {}, now = new Date(),
}) {
  const allowance = settings.home_allowance_days || DEFAULT_HOME_ALLOWANCE_DAYS;
  return classifyOpenCycles({ roadHistory, homeStatus })
    .filter((c) => c.evidenceClass === 'C')
    .map(({ cycle }) => ({ cycle, days: daysBetween(cycle.home_arrived_at, now) }))
    .filter(({ days }) => days != null && days > allowance + GRACE_DAYS)
    .map(({ cycle, days }) => ({
      checkKey: 'home_time.home_stay_past_allowance',
      subjectType: 'group',
      subjectId: cycle.group_id,
      title: `${groupLabel(groupsById.get(cycle.group_id), cycle.group_id)}: home for ${days} days `
        + `(allowance ${allowance})`,
      // Months at home is a different conversation from a few days over.
      severity: days > allowance * 5 ? 'serious' : 'warning',
      tier: 'warning',
      evidence: {
        groupId: cycle.group_id,
        cycleId: cycle.id,
        homeArrivedAt: cycle.home_arrived_at,
        daysHome: days,
        allowanceDays: allowance,
      },
    }));
}

/** A driver out past the road allowance — the bonus side of the same policy. */
function checkRoadClockPastAllowance({
  homeStatus = [], groupsById = new Map(), settings = {}, now = new Date(),
}) {
  const weeks = settings.road_allowance_weeks || DEFAULT_ROAD_ALLOWANCE_WEEKS;
  const allowanceDays = weeks * 7;
  const findings = [];
  for (const status of homeStatus) {
    if (status.state !== 'road') continue;
    const group = groupsById.get(status.group_id);
    // Only live driver groups: a stale row for a departed driver is a different
    // finding, and reporting it here would double-count it.
    if (!group || group.active !== true || group.group_type !== 'driver') continue;
    const days = daysBetween(status.state_since, now);
    if (days == null || days <= allowanceDays) continue;

    findings.push({
      checkKey: 'home_time.road_clock_past_allowance',
      subjectType: 'group',
      subjectId: status.group_id,
      title: `${groupLabel(group, status.group_id)}: on the road ${days} days (allowance ${allowanceDays})`,
      severity: days > allowanceDays * 2 ? 'warning' : 'info',
      tier: 'warning',
      evidence: {
        groupId: status.group_id,
        stateSince: status.state_since,
        daysOnRoad: days,
        allowanceDays,
        roadAllowanceWeeks: weeks,
      },
    });
  }
  return findings;
}

/**
 * A home-status row for a group that is gone or inactive.
 *
 * 54 in production. Harmless on its own, but it is what makes every count of
 * "drivers on the road" quietly wrong.
 */
function checkGhostHomeStatus({ homeStatus = [], groupsById = new Map() }) {
  return homeStatus
    .filter((status) => {
      const group = groupsById.get(status.group_id);
      return !group || group.active !== true;
    })
    .map((status) => {
      const group = groupsById.get(status.group_id);
      return {
        checkKey: 'home_time.ghost_home_status',
        subjectType: 'group',
        subjectId: status.group_id,
        title: `${groupLabel(group, status.group_id)}: still tracked as "${status.state}" but the group is `
          + `${group ? 'inactive' : 'gone'}`,
        severity: 'info',
        tier: 'auto',
        confidence: 90,
        evidence: {
          groupId: status.group_id,
          state: status.state,
          stateSince: status.state_since,
          groupExists: Boolean(group),
          groupActive: group ? group.active : null,
        },
        proposedChange: {
          table: 'driver_home_status',
          groupId: status.group_id,
          action: 'retire',
        },
      };
    });
}

const CHECKS = [
  checkClosableCycles,
  checkHomeStayPastAllowance,
  checkRoadClockPastAllowance,
  checkGhostHomeStatus,
];

const CHECK_KEYS = [
  'home_time.closable_open_cycle',
  'home_time.home_stay_past_allowance',
  'home_time.road_clock_past_allowance',
  'home_time.ghost_home_status',
];

function runHomeTimeChecks(snapshot) {
  return CHECKS.flatMap((check) => check(snapshot));
}

module.exports = {
  DEFAULT_HOME_ALLOWANCE_DAYS,
  DEFAULT_ROAD_ALLOWANCE_WEEKS,
  GRACE_DAYS,
  CHECK_KEYS,
  classifyOpenCycles,
  runHomeTimeChecks,
  checkClosableCycles,
  checkHomeStayPastAllowance,
  checkRoadClockPastAllowance,
  checkGhostHomeStatus,
};
