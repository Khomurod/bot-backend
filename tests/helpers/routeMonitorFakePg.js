'use strict';

/**
 * A fake `pg` for the Route Control monitor, answering from an in-memory world
 * and recording what every statement would have cost on the wire.
 *
 * Requiring this file installs it: `pg` is replaced before any data module
 * loads, and the live-GPS resolver (network I/O to Samsara / Drive HoS) is
 * replaced by a lookup in `world.locations`. Everything else — the monitor, the
 * completion gate, the repair, the run ledger and the whole data layer — is the
 * real code.
 *
 * The fake PROJECTS each SELECT / RETURNING list from full rows that carry
 * every column the real tables have, which is what makes it honest:
 *   - a whole-row read returns a whole row, as PostgreSQL would;
 *   - a narrow read returns only what it named, so a column the monitor uses
 *     but forgot to select becomes a behaviour change the tests see;
 *   - a column the real table does not have fails loudly.
 *
 * Bytes follow the wire format: a RowDescription is about 19 B plus the name
 * per column and is sent even when no row comes back; a DataRow is about 7 B,
 * plus 4 B per column, plus the value text.
 */
const crypto = require('node:crypto');
const path = require('node:path');

const md5 = (v) => (v == null ? null : crypto.createHash('md5').update(String(v)).digest('hex'));
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

const ROUTE_COLUMNS = [
  'id', 'group_id', 'driver_profile_id', 'driver_label', 'unit_number', 'original_url', 'origin_text',
  'destination_text', 'waypoints', 'origin_lat', 'origin_lng', 'destination_lat', 'destination_lng',
  'encoded_polyline', 'distance_meters', 'duration_seconds', 'status', 'assigned_by', 'last_checked_at',
  'last_latitude', 'last_longitude', 'last_deviation_meters', 'last_check_result', 'consecutive_off_route',
  'last_notification_at', 'created_at', 'updated_at', 'source', 'assigned_by_user_id', 'telegram_chat_id',
  'telegram_message_id', 'driver_group_message_sent_at', 'driver_group_message_id',
  'driver_group_message_sent_by', 'tracking_status', 'tracking_start_mode', 'tracking_start_at',
  'tracking_started_at', 'tracking_start_lat', 'tracking_start_lng', 'tracking_start_location_text',
  'tracking_start_radius_miles', 'tracking_hold_reason', 'completed_at', 'completion_latitude',
  'completion_longitude', 'completion_distance_meters', 'completion_reason', 'last_completion_check_at',
  'last_destination_distance_meters', 'completion_blocked_reason', 'destination_repair_attempts',
  'destination_repair_last_at', 'driver_group_message_via', 'screenshot_send_error', 'driver_group_messages',
  'driver_group_message_edited_at', 'driver_group_message_edit_error', 'person_id',
];
const GROUP_COLUMNS = ['id', 'telegram_group_id', 'group_name', 'group_type', 'active', 'status_source', 'language'];
const PROFILE_COLUMNS = [
  'id', 'group_id', 'first_name', 'last_name', 'secondary_first_name', 'secondary_last_name', 'driver_type',
  'status', 'unit_number', 'unit_number_source', 'language', 'date_of_birth', 'date_of_start', 'needs_review',
  'created_at', 'updated_at',
];
const GMAPS_COLUMNS = [
  'id', 'enabled', 'server_api_key_encrypted', 'routes_api_enabled', 'roads_api_enabled',
  'geocoding_api_enabled', 'geocoding_api_key_encrypted', 'deviation_threshold_meters',
  'check_interval_seconds', 'off_route_grace_checks', 'warning_cooldown_minutes', 'stale_gps_minutes',
  'parked_speed_mph', 'updated_at', 'route_completion_radius_miles', 'completion_radius_35_migrated',
  'completion_radius_50_migrated',
];
const EVENT_COLUMNS = [
  'id', 'assignment_id', 'event_type', 'result', 'latitude', 'longitude', 'deviation_meters', 'detail', 'created_at',
];

const blank = (columns) => Object.fromEntries(columns.map((c) => [c, null]));

const world = {};
const log = [];

function reset({ gmapsEnabled = true } = {}) {
  Object.assign(world, {
    gmaps: {
      ...blank(GMAPS_COLUMNS), id: 1, enabled: gmapsEnabled, server_api_key_encrypted: null,
      routes_api_enabled: true, roads_api_enabled: false, geocoding_api_enabled: false,
      deviation_threshold_meters: 250, check_interval_seconds: 300, off_route_grace_checks: 3,
      warning_cooldown_minutes: 30, stale_gps_minutes: 15, parked_speed_mph: 5,
      route_completion_radius_miles: 50, completion_radius_35_migrated: true,
      completion_radius_50_migrated: true, updated_at: new Date('2026-10-01T00:00:00Z'),
    },
    groups: new Map(),
    profiles: new Map(),
    routes: [],
    events: [],
    monitorStates: [],
    diagnostics: [],
    locations: new Map(),
    resolved: [],
    sends: [],
  });
}
reset();

function addGroup(id, groupName) {
  world.groups.set(id, {
    ...blank(GROUP_COLUMNS), id, telegram_group_id: String(-1001000000000 - id), group_name: groupName,
    group_type: 'driver', active: true, status_source: 'bot', language: 'en',
  });
}

function addProfile(groupId, unitNumber) {
  world.profiles.set(groupId, {
    ...blank(PROFILE_COLUMNS), id: groupId, group_id: groupId, first_name: 'Test', last_name: 'Driver',
    unit_number: unitNumber, status: 'active', language: 'en',
  });
}

/** A route as the table stores it — every column, with production-sized text. */
function routeRow(overrides = {}) {
  const id = overrides.id;
  const created = new Date('2026-10-08T12:00:00Z');
  return {
    ...blank(ROUTE_COLUMNS),
    group_id: id,
    driver_label: 'Test Driver',
    original_url: `https://www.google.com/maps/dir/${'Chicago,+IL/'.repeat(12)}@41.8,-87.6,6z/data=${'!4m2'.repeat(60)}`,
    origin_text: '2200 S Michigan Ave, Chicago, IL 60616, USA',
    destination_text: '1500 Marilla St, Dallas, TX 75201, USA',
    waypoints: [{ raw: 'St. Louis, MO, USA', lat: 38.627, lng: -90.199 }, { raw: 'Little Rock, AR, USA', lat: 34.746, lng: -92.289 }],
    distance_meters: 1480000,
    duration_seconds: 52000,
    status: 'active',
    assigned_by: 'dispatch',
    consecutive_off_route: 0,
    created_at: created,
    updated_at: new Date(created.getTime() + id * 1000),
    source: 'admin',
    driver_group_message_sent_at: created,
    driver_group_message_id: 71,
    driver_group_message_sent_by: 'dispatch',
    tracking_status: 'active',
    tracking_start_mode: 'immediate',
    tracking_started_at: created,
    destination_repair_attempts: 0,
    driver_group_message_via: 'photo+text',
    driver_group_messages: [{ message_id: 71, kind: 'photo' }, { message_id: 72, kind: 'text' }],
    ...overrides,
  };
}

/** Google's polyline encoding — enough to build test routes of a realistic size. */
function encodePolyline(points) {
  const enc = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  let out = '';
  let pLat = 0;
  let pLng = 0;
  for (const [lat, lng] of points) {
    const la = Math.round(lat * 1e5);
    const ln = Math.round(lng * 1e5);
    out += enc(la - pLat) + enc(ln - pLng);
    pLat = la;
    pLng = ln;
  }
  return out;
}

/** A polyline through `vertices`, densified the way a computed route is. */
function densePolyline(vertices, perLeg = 250) {
  const points = [];
  for (let i = 0; i < vertices.length - 1; i += 1) {
    const [aLat, aLng] = vertices[i];
    const [bLat, bLng] = vertices[i + 1];
    for (let k = 0; k < perLeg; k += 1) {
      points.push([aLat + ((bLat - aLat) * k) / perLeg, aLng + ((bLng - aLng) * k) / perLeg]);
    }
  }
  points.push(vertices[vertices.length - 1]);
  return encodePolyline(points);
}

// ── the projection ──────────────────────────────────────────────────────────

/** Split a SELECT / RETURNING list at the commas outside parentheses. */
function splitItems(list) {
  const items = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    else if (list[i] === ')') depth -= 1;
    else if (list[i] === ',' && depth === 0) { items.push(list.slice(start, i).trim()); start = i + 1; }
  }
  items.push(list.slice(start).trim());
  return items.filter(Boolean);
}

function projectionOf(sql) {
  const returning = sql.match(/\bRETURNING (.+)$/i);
  if (returning) return splitItems(returning[1]);
  const select = sql.match(/^SELECT (.+?) FROM /i);
  return select ? splitItems(select[1]) : [];
}

function sourceOf(sources, alias, item) {
  const src = sources[alias || ''];
  if (!src) throw new Error(`the fake pg has no table aliased "${alias || ''}" for "${item}"`);
  return src;
}

function columnOf(sources, alias, name, item) {
  const src = sourceOf(sources, alias, item);
  if (!(name in src)) throw new Error(`no column "${name}" in the table behind "${item}"`);
  return src[name];
}

function project(items, sources) {
  const out = {};
  for (const item of items) {
    let m = item.match(/^(?:(\w+)\.)?\*$/);
    if (m) { Object.assign(out, sourceOf(sources, m[1], item)); continue; }
    m = item.match(/^md5\((?:(\w+)\.)?(\w+)\) AS (\w+)$/i);
    if (m) { out[m[3]] = md5(columnOf(sources, m[1], m[2], item)); continue; }
    m = item.match(/^(?:(\w+)\.)?(\w+)(?: AS (\w+))?$/i);
    if (m) { out[m[3] || m[2]] = columnOf(sources, m[1], m[2], item); continue; }
    throw new Error(`the fake pg cannot project "${item}"`);
  }
  return out;
}

const textLength = (v) => {
  if (v == null) return 0;
  if (v instanceof Date) return v.toISOString().length;
  return Buffer.byteLength(typeof v === 'object' ? JSON.stringify(v) : String(v));
};

/** The approximate bytes a response carries: the description, then each row. */
function wireBytes(fields, rows) {
  if (!fields.length) return 0;
  const describe = 7 + fields.reduce((n, f) => n + 19 + f.length, 0);
  return rows.reduce((n, row) => n + 7 + fields.reduce((m, f) => m + 4 + textLength(row[f]), 0), describe);
}

function answer(items, sourceRows, template, rowCount) {
  if (!items.length) return { rows: [], rowCount: rowCount ?? sourceRows.length, fields: [] };
  const fields = Object.keys(project(items, template));
  const rows = sourceRows.map((s) => project(items, s));
  return { rows, rowCount: rowCount ?? rows.length, fields };
}

const NO_GROUP = blank(GROUP_COLUMNS);
const groupOf = (id) => world.groups.get(id) || NO_GROUP;
const ROUTE_TEMPLATE = { '': blank(ROUTE_COLUMNS), r: blank(ROUTE_COLUMNS), g: NO_GROUP };

function selectRoutes(sql, values, items) {
  let found = world.routes;
  if (/WHERE (?:r\.)?id = \$1/i.test(sql)) found = found.filter((r) => r.id === Number(values[0]));
  if (/WHERE (?:r\.)?status = 'active'/i.test(sql)) found = found.filter((r) => r.status === 'active');
  found = [...found].sort((a, b) => a.updated_at - b.updated_at);
  if (/ LIMIT 1$/i.test(sql)) found = found.slice(0, 1);
  return answer(items, found.map((r) => ({ '': r, r, g: groupOf(r.group_id) })), ROUTE_TEMPLATE);
}

function updateRoute(sql, values, items) {
  const route = world.routes.find((r) => r.id === Number(values[0]));
  let hit = Boolean(route);
  if (hit && /AND status = 'active'/i.test(sql)) hit = route.status === 'active';
  if (hit && /AND tracking_status <> 'active'/i.test(sql)) hit = route.tracking_status !== 'active';
  if (hit) {
    if (/SET status = 'completed'/i.test(sql)) route.status = 'completed';
    if (/SET tracking_status = 'active'/i.test(sql)) route.tracking_status = 'active';
    if (/last_check_result = \$6/i.test(sql)) world.monitorStates.push({ id: route.id, result: values[5] });
    if (/completion_blocked_reason = \$4/i.test(sql)) world.diagnostics.push({ id: route.id, blockedReason: values[3] });
  }
  return answer(items, hit ? [{ '': route }] : [], { '': blank(ROUTE_COLUMNS) }, hit ? 1 : 0);
}

function insertEvent(values, items) {
  const [assignmentId, eventType, result, latitude, longitude, deviationMeters, detail] = values;
  const event = {
    id: world.events.length + 1, assignment_id: assignmentId, event_type: eventType, result,
    latitude, longitude, deviation_meters: deviationMeters, detail, created_at: new Date(),
  };
  world.events.push(event);
  return answer(items, [{ '': event }], { '': blank(EVENT_COLUMNS) }, 1);
}

function respond(sql, values = []) {
  const items = projectionOf(sql);
  if (/FROM gmaps_settings\b/i.test(sql)) return answer(items, [{ '': world.gmaps }], { '': blank(GMAPS_COLUMNS) });
  if (/^SELECT .* FROM route_assignments\b/i.test(sql)) return selectRoutes(sql, values, items);
  if (/FROM driver_profiles\b/i.test(sql)) {
    const profile = world.profiles.get(Number(values[0]));
    const template = { '': blank(PROFILE_COLUMNS), dp: blank(PROFILE_COLUMNS), g: NO_GROUP };
    return answer(items, profile ? [{ '': profile, dp: profile, g: groupOf(profile.group_id) }] : [], template);
  }
  if (/^UPDATE route_assignments\b/i.test(sql)) return updateRoute(sql, values, items);
  if (/^INSERT INTO route_monitor_events\b/i.test(sql)) return insertEvent(values, items);
  return { rows: [], rowCount: /^(INSERT|UPDATE|DELETE)\b/i.test(sql) ? 1 : 0, fields: [] };
}

class FakePool {
  on() {}

  async query(text, values) {
    const sql = oneLine(typeof text === 'string' ? text : text?.text || '');
    const result = respond(sql, values);
    log.push({ sql, fields: result.fields, rows: result.rows.length, bytes: wireBytes(result.fields, result.rows) });
    return result;
  }

  async connect() { return { query: (t, v) => this.query(t, v), release() {} }; }
}

const install = (file, exports) => {
  const filename = require.resolve(file);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
install('pg', { Pool: FakePool });
install(path.resolve(__dirname, '../../services/liveLocationResolver.js'), {
  async resolveLiveLocationForGroupTitle(groupTitle, { unitNumber = null } = {}) {
    world.resolved.push({ groupTitle, unitNumber });
    const location = world.locations.get(unitNumber);
    if (!location) {
      const err = new Error('no live GPS for this unit');
      err.code = 'LOCATION_PROVIDER_FAILED';
      throw err;
    }
    return { location: { ...location }, source: 'Samsara' };
  },
});

const telegram = {
  async sendMessage(chatId, text) { world.sends.push({ chatId, text }); return { message_id: world.sends.length }; },
};

/** Run `fn` and hand back every statement it sent. */
async function record(fn) {
  log.length = 0;
  await fn();
  return log.splice(0);
}

/** Run `fn` with Date.now() pinned `minutes` after a fixed start. */
const T0 = Date.parse('2026-10-09T12:00:00Z');
async function atMinute(minutes, fn) {
  const realNow = Date.now;
  Date.now = () => T0 + minutes * 60_000;
  try { return await fn(); } finally { Date.now = realNow; }
}

module.exports = {
  world, reset, addGroup, addProfile, routeRow, densePolyline, telegram, record, atMinute,
};
