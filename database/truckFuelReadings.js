/**
 * The last fuel reading per truck — the memory abnormal-consumption needs.
 *
 * WHY IT DID NOT EXIST. `assessFuelRisk` has always carried an abnormal-burn
 * branch that needs two readings of BOTH fuel percentage and odometer. The only
 * caller, `services/fuelStop/riskWatch.js`, handed it `fuelPercent: null,
 * odometerMiles: null` hard-coded — so the branch could not fire, ever. Dead
 * code wearing a working feature's clothes.
 *
 * WHAT THIS IS NOT. It is not a position history, and the application
 * deliberately does not keep one. ONE ROW PER TRUCK, updated in place: about
 * 110 rows for a 110-truck fleet, forever, no prune pass needed.
 *
 * THE BASELINE IS THE POINT. Comparing consecutive 20-minute samples measures
 * noise — a truck that moved four miles between passes produces a burn rate
 * with a rounding error for a denominator. So each row keeps a `baseline_*`
 * triple that only advances once REAL distance has accumulated, and the
 * comparison is always current-versus-baseline.
 *
 * Three things reset the baseline instead of advancing it, and each is a case
 * where burn measured across it would be a lie:
 *
 *   - a REFUEL (the tank rose) — fuel "used" across a fill-up is meaningless;
 *   - an odometer that went BACKWARDS or jumped implausibly — a different
 *     vehicle now answers to this unit number, or the provider changed units;
 *   - a baseline gone STALE (no reading for days) — the truck was parked, or
 *     the fleet feed was down, and neither is a burn rate.
 *
 * Missing data means UNKNOWN. A null fuel percentage is never stored as zero
 * and never compared: a truck whose provider reports no tank level must produce
 * no burn finding at all, rather than a spectacular one.
 */
const { query } = require('./pool');

/** A tank that rose by more than this is a fill-up, not sensor drift. */
const REFUEL_RISE_PERCENT = 4;
/** Below this the denominator is too small for the rate to mean anything. */
const MIN_BASELINE_MILES = 50;
/** Past this the window is long enough; start a fresh one. */
const ADVANCE_AFTER_MILES = 400;
/** A baseline older than this describes a different trip. */
const STALE_BASELINE_HOURS = 72;
/** An odometer jump larger than this between readings is a data fault. */
const IMPLAUSIBLE_JUMP_MILES = 3000;

function num(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapRow(row) {
  if (!row) return null;
  return {
    unitNumber: row.unit_number,
    personId: row.person_id == null ? null : Number(row.person_id),
    groupId: row.group_id == null ? null : Number(row.group_id),
    fuelPercent: num(row.fuel_percent),
    odometerMiles: num(row.odometer_miles),
    recordedAt: row.recorded_at,
    baselineFuelPercent: num(row.baseline_fuel_percent),
    baselineOdometerMiles: num(row.baseline_odometer_miles),
    baselineAt: row.baseline_at,
    baselineReason: row.baseline_reason,
    updatedAt: row.updated_at,
  };
}

/**
 * Decide what the next baseline should be. PURE — no I/O, fully testable.
 *
 * @param {object|null} stored  the row as it stands, or null on first sight
 * @param {{fuelPercent:number|null, odometerMiles:number|null, recordedAt:string}} current
 * @returns {{previous: {fuelPercent:number|null, odometerMiles:number|null}|null,
 *   baseline: {fuelPercent:number|null, odometerMiles:number|null, at:string, reason:string},
 *   reason: string}}
 *   `previous` is what the risk assessor should compare against — NULL whenever
 *   comparing would be dishonest, which is most of the time and by design.
 */
function decideBaseline(stored, current) {
  const fresh = (reason) => ({
    previous: null,
    baseline: {
      fuelPercent: current.fuelPercent,
      odometerMiles: current.odometerMiles,
      at: current.recordedAt,
      reason,
    },
    reason,
  });

  // Nothing usable to anchor on. Keep whatever is stored rather than replacing
  // a real baseline with a hole — a fleet feed that drops a field for one pass
  // must not cost the window that was being built.
  if (current.fuelPercent == null || current.odometerMiles == null) {
    return {
      previous: null,
      baseline: stored?.baselineOdometerMiles != null ? {
        fuelPercent: stored.baselineFuelPercent,
        odometerMiles: stored.baselineOdometerMiles,
        at: stored.baselineAt,
        reason: stored.baselineReason || 'first',
      } : null,
      reason: 'incomplete_reading',
    };
  }

  if (!stored || stored.baselineOdometerMiles == null || stored.baselineFuelPercent == null) {
    return fresh('first');
  }

  const miles = current.odometerMiles - stored.baselineOdometerMiles;
  if (miles < 0 || miles > IMPLAUSIBLE_JUMP_MILES) return fresh('reset');

  if (current.fuelPercent > stored.baselineFuelPercent + REFUEL_RISE_PERCENT) {
    return fresh('refuel');
  }

  const ageHours = stored.baselineAt
    ? (Date.parse(current.recordedAt) - Date.parse(stored.baselineAt)) / 3600000
    : null;
  if (ageHours != null && Number.isFinite(ageHours) && ageHours > STALE_BASELINE_HOURS) {
    return fresh('stale');
  }

  const comparable = miles >= MIN_BASELINE_MILES;
  const previous = comparable
    ? { fuelPercent: stored.baselineFuelPercent, odometerMiles: stored.baselineOdometerMiles }
    : null;

  // Once the window is long enough to have been judged, start the next one from
  // here — otherwise a truck that ran 4 000 miles on one tank would keep
  // reporting the same averaged rate until it refuelled.
  if (comparable && miles >= ADVANCE_AFTER_MILES) {
    return {
      previous,
      baseline: {
        fuelPercent: current.fuelPercent,
        odometerMiles: current.odometerMiles,
        at: current.recordedAt,
        reason: 'distance',
      },
      reason: 'advanced',
    };
  }

  return {
    previous,
    baseline: {
      fuelPercent: stored.baselineFuelPercent,
      odometerMiles: stored.baselineOdometerMiles,
      at: stored.baselineAt,
      reason: stored.baselineReason || 'first',
    },
    reason: comparable ? 'comparable' : 'accumulating',
  };
}

/** One truck's stored reading, or null. */
async function getReading(unitNumber) {
  if (!unitNumber) return null;
  const res = await query(
    'SELECT * FROM truck_fuel_readings WHERE unit_number = $1',
    [String(unitNumber)]
  );
  return mapRow(res.rows[0]);
}

/**
 * Store this pass's reading and return what it may be compared against.
 *
 * NEVER THROWS on a missing table — the fuel watch must keep running against a
 * database whose migration has not landed yet, and a burn finding is the least
 * important thing it produces.
 *
 * @returns {Promise<{previous: object|null, reason: string}>}
 */
async function recordAndCompare({
  unitNumber, personId = null, groupId = null,
  fuelPercent = null, odometerMiles = null, recordedAt = null,
}) {
  if (!unitNumber) return { previous: null, reason: 'no_unit' };
  const current = {
    fuelPercent: num(fuelPercent),
    odometerMiles: num(odometerMiles),
    recordedAt: recordedAt || new Date().toISOString(),
  };

  try {
    const stored = await getReading(unitNumber);
    const decision = decideBaseline(stored, current);
    const b = decision.baseline;

    await query(
      `INSERT INTO truck_fuel_readings
         (unit_number, person_id, group_id, fuel_percent, odometer_miles, recorded_at,
          baseline_fuel_percent, baseline_odometer_miles, baseline_at, baseline_reason, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9::timestamptz,$10,NOW())
       ON CONFLICT (unit_number) DO UPDATE SET
         -- COALESCE ON IDENTITY ONLY. A pass that could not resolve the person
         -- must not erase the one an earlier pass did resolve: who drives a
         -- truck does not stop being true because one lookup failed.
         person_id = COALESCE(EXCLUDED.person_id, truck_fuel_readings.person_id),
         group_id = COALESCE(EXCLUDED.group_id, truck_fuel_readings.group_id),
         -- BUT NEVER ON THE TELEMETRY. A COALESCE here kept the last fuel
         -- percentage a truck ever reported, forever, while recorded_at went on
         -- advancing -- so a truck whose provider stopped sending the field was
         -- still counted as fuel-capable and comparable, and the health block
         -- added to prove the abnormal-burn engine can SEE would claim it could
         -- see when it could not. Missing data must read as missing; a null
         -- overwrites. (See the module header and the Pg tests.)
         fuel_percent = EXCLUDED.fuel_percent,
         odometer_miles = EXCLUDED.odometer_miles,
         -- Always advances: this function is only reached for a truck whose
         -- position resolved, so it means "when we last SAW this truck", which
         -- is the question the ELD freshness check asks it.
         recorded_at = EXCLUDED.recorded_at,
         baseline_fuel_percent = EXCLUDED.baseline_fuel_percent,
         baseline_odometer_miles = EXCLUDED.baseline_odometer_miles,
         baseline_at = EXCLUDED.baseline_at,
         baseline_reason = EXCLUDED.baseline_reason,
         updated_at = NOW()`,
      [
        String(unitNumber), personId, groupId,
        current.fuelPercent, current.odometerMiles, current.recordedAt,
        b ? b.fuelPercent : null, b ? b.odometerMiles : null,
        b ? b.at : null, b ? b.reason : null,
      ]
    );
    return { previous: decision.previous, reason: decision.reason };
  } catch (err) {
    console.warn(`[FUEL-READINGS] ${unitNumber}:`, err.message);
    return { previous: null, reason: `error: ${err.message}` };
  }
}

/**
 * How much of the fleet this can actually answer for.
 *
 * Exported for `/api/health`: "no abnormal-burn findings" is only good news if
 * some trucks have a usable comparison window. Zero comparable trucks and zero
 * findings are the same silence, and they mean opposite things.
 */
async function summariseFuelReadings() {
  try {
    const res = await query(
      `SELECT COUNT(*) AS trucks,
              COUNT(*) FILTER (WHERE fuel_percent IS NOT NULL) AS with_fuel,
              COUNT(*) FILTER (WHERE odometer_miles IS NOT NULL
                                 AND baseline_odometer_miles IS NOT NULL
                                 AND odometer_miles - baseline_odometer_miles >= $1) AS comparable,
              MAX(recorded_at) AS newest_reading
         FROM truck_fuel_readings`,
      [MIN_BASELINE_MILES]
    );
    const row = res.rows[0] || {};
    return {
      trucks: Number(row.trucks) || 0,
      withFuel: Number(row.with_fuel) || 0,
      comparable: Number(row.comparable) || 0,
      newestReading: row.newest_reading || null,
    };
  } catch (_) {
    return { trucks: 0, withFuel: 0, comparable: 0, newestReading: null, available: false };
  }
}

module.exports = {
  REFUEL_RISE_PERCENT,
  MIN_BASELINE_MILES,
  ADVANCE_AFTER_MILES,
  STALE_BASELINE_HOURS,
  IMPLAUSIBLE_JUMP_MILES,
  decideBaseline,
  getReading,
  recordAndCompare,
  summariseFuelReadings,
};
