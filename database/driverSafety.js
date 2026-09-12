/**
 * Safety events, kept so a driver's PATTERN can be seen.
 *
 * Until this table existed the events were formatted, sent to Telegram and
 * thrown away — the only durable trace was an id for deduplication. So "how
 * many harsh-braking events has this driver had this month" had never been
 * answerable, and every alert was necessarily treated as an isolated incident.
 *
 * Reads group by `person_id` wherever there is one. A driver who changes truck
 * or chat is the same person, and a safety history that resets on a truck
 * change is worse than none: it hides exactly the driver a pattern would find.
 */
const { query } = require('./pool');
const { toTimestampValue } = require('../lib/database/timestampValue');

function mapEvent(row) {
  if (!row) return null;
  return {
    samsaraEventId: row.samsara_event_id,
    personId: row.person_id,
    groupId: row.group_id,
    vehicleId: row.vehicle_id,
    unitNumber: row.unit_number,
    driverName: row.driver_name,
    behavior: row.behavior,
    severity: row.severity,
    gForce: row.g_force,
    speedMph: row.speed_mph,
    postedSpeedMph: row.posted_speed_mph,
    occurredAt: row.occurred_at,
    lat: row.lat,
    lng: row.lng,
  };
}

/**
 * Record one event.
 *
 * `ON CONFLICT DO NOTHING` on Samsara's own id: the poller re-reads a window on
 * every pass, so without it one hard brake would become a pattern by itself.
 *
 * @returns {Promise<object|null>} the row, or null when already known.
 */
async function recordSafetyEvent({
  samsaraEventId, personId = null, groupId = null, vehicleId = null, unitNumber = null,
  driverName = null, behavior, severity = null, gForce = null, speedMph = null,
  postedSpeedMph = null, occurredAt, lat = null, lng = null,
}) {
  // WHEN THE EVENT HAS NO READABLE TIME, IT IS NOT RECORDED — deliberately,
  // and this is the whole policy.
  //
  // `occurredAt` is Samsara's timestamp, not ours, and `occurred_at` is NOT
  // NULL (migration 0033). Binding a null would swap one exception for another
  // rather than making the writer resilient, and inventing a time — NOW(), the
  // ingest time — would be worse than both: every window, every coaching
  // decision and every duplicate check in this table is keyed on WHEN the event
  // happened. A safety event at the wrong time is a coaching message to the
  // wrong driver about the wrong afternoon.
  //
  // So it is refused, loudly enough to find in a log and quietly enough not to
  // stop a poller. The caller already reads null as "not recorded".
  const occurred = toTimestampValue(occurredAt);
  if (!occurred) {
    console.warn(`[SAFETY] event ${String(samsaraEventId)} has no readable occurred_at; not recorded`);
    return null;
  }

  const res = await query(
    `INSERT INTO driver_safety_events
       (samsara_event_id, person_id, group_id, vehicle_id, unit_number, driver_name,
        behavior, severity, g_force, speed_mph, posted_speed_mph, occurred_at, lat, lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14)
     ON CONFLICT (samsara_event_id) DO NOTHING
     RETURNING *`,
    [
      String(samsaraEventId), personId, groupId, vehicleId, unitNumber, driverName,
      String(behavior), severity, gForce, speedMph, postedSpeedMph, occurred, lat, lng,
    ]
  );
  return mapEvent(res.rows[0]) || null;
}

/** Every driver with at least one event in the window, with their events. */
async function listDriversWithRecentEvents({ windowDays = 14, minEvents = 3 } = {}) {
  const res = await query(
    `SELECT e.*, g.telegram_group_id, g.active AS group_active
       FROM driver_safety_events e
       LEFT JOIN groups g ON g.id = e.group_id
      WHERE e.occurred_at > NOW() - ($1 || ' days')::interval
      ORDER BY e.occurred_at DESC`,
    [String(windowDays)]
  );
  // Grouped by PERSON where there is one, falling back to the chat so a driver
  // not yet matched to an identity is still coachable rather than invisible.
  const byDriver = new Map();
  for (const row of res.rows) {
    const key = row.person_id ? `person:${row.person_id}` : `group:${row.group_id}`;
    if (row.person_id == null && row.group_id == null) continue;
    if (!byDriver.has(key)) {
      byDriver.set(key, {
        key,
        personId: row.person_id,
        groupId: row.group_id,
        unitNumber: row.unit_number,
        driverName: row.driver_name,
        // Needed to reach the driver at all, and `active` so a coaching note
        // never lands in a chat the driver has left.
        telegramGroupId: row.group_active ? row.telegram_group_id : null,
        events: [],
      });
    }
    byDriver.get(key).events.push(mapEvent(row));
  }
  return [...byDriver.values()].filter((d) => d.events.length >= minEvents);
}

/** What has already been said to this driver, so coaching does not nag. */
async function listCoachingFor({ personId = null, groupId = null, sinceDays = 60 } = {}) {
  if (personId == null && groupId == null) return [];
  const res = await query(
    `SELECT behavior, sent_at, delivered_to, event_count
       FROM driver_safety_coaching
      WHERE ($1::int IS NOT NULL AND person_id = $1
             OR $1::int IS NULL AND group_id = $2)
        AND sent_at > NOW() - ($3 || ' days')::interval
      ORDER BY sent_at DESC`,
    [personId, groupId, String(sinceDays)]
  );
  return res.rows.map((r) => ({
    behavior: r.behavior, sentAt: r.sent_at, deliveredTo: r.delivered_to, eventCount: r.event_count,
  }));
}

/** Record that a driver was coached, and about what. */
async function recordCoaching({
  personId = null, groupId = null, behavior, eventCount, windowDays,
  message = null, deliveredTo = 'operations', telegramMessageId = null,
}) {
  const res = await query(
    `INSERT INTO driver_safety_coaching
       (person_id, group_id, behavior, event_count, window_days, message, delivered_to, telegram_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [personId, groupId, String(behavior), eventCount, windowDays, message, deliveredTo, telegramMessageId]
  );
  return res.rows[0];
}

/** For /api/health and the fleet view: what kinds of events, and how many drivers. */
async function summariseSafety({ windowDays = 14 } = {}) {
  const res = await query(
    `SELECT behavior, COUNT(*)::int AS n,
            COUNT(DISTINCT COALESCE(person_id::text, 'g' || group_id::text))::int AS drivers
       FROM driver_safety_events
      WHERE occurred_at > NOW() - ($1 || ' days')::interval
      GROUP BY behavior
      ORDER BY n DESC`,
    [String(windowDays)]
  );
  const coached = await query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE delivered_to = 'driver_group')::int AS toDrivers
       FROM driver_safety_coaching
      WHERE sent_at > NOW() - ($1 || ' days')::interval`,
    [String(windowDays)]
  );
  return {
    windowDays,
    events: res.rows.reduce((n, r) => n + r.n, 0),
    byBehavior: Object.fromEntries(res.rows.map((r) => [r.behavior, r.n])),
    driversWithEvents: res.rows.reduce((m, r) => Math.max(m, r.drivers), 0),
    coachingSent: coached.rows[0]?.n || 0,
    coachingToDrivers: coached.rows[0]?.todrivers ?? coached.rows[0]?.toDrivers ?? 0,
  };
}

/** Drop events past the window worth keeping. */
async function pruneOldSafetyEvents({ keepDays = 180 } = {}) {
  const res = await query(
    `DELETE FROM driver_safety_events WHERE occurred_at < NOW() - ($1 || ' days')::interval`,
    [String(keepDays)]
  );
  return res.rowCount;
}

module.exports = {
  recordSafetyEvent,
  listDriversWithRecentEvents,
  listCoachingFor,
  recordCoaching,
  summariseSafety,
  pruneOldSafetyEvents,
};
