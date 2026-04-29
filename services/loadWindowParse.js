const { DateTime } = require('luxon');

const DEFAULT_ZONE = 'America/Chicago';

/**
 * Best-effort parse of broker-style date/time strings into UTC JS Dates.
 */
function parseFlexibleLocalDateTime(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  let dt = DateTime.fromISO(raw, { setZone: true });
  if (dt.isValid) return dt.toUTC().toJSDate();

  const formats = [
    'MM/dd/yyyy HH:mm',
    'M/d/yyyy HH:mm',
    'MM/dd/yyyy H:mm',
    'M/d/yyyy H:mm',
    'MM/dd/yyyy HHmm',
    'yyyy-MM-dd HH:mm',
    'yyyy-MM-dd',
    'MM/dd/yy HH:mm',
  ];

  for (const fmt of formats) {
    dt = DateTime.fromFormat(raw, fmt, { zone: DEFAULT_ZONE });
    if (dt.isValid) return dt.toUTC().toJSDate();
  }

  const natural = DateTime.fromRFC2822(raw);
  if (natural.isValid) return natural.toUTC().toJSDate();

  return null;
}

/**
 * If the string contains "to", treat as [start, end] in local zone.
 */
function parseRangeBoundaries(text) {
  const raw = String(text || '').trim();
  if (!raw) return { start: null, end: null };
  const parts = raw.split(/\s+to\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const start = parseFlexibleLocalDateTime(parts[0]);
    const end = parseFlexibleLocalDateTime(parts[parts.length - 1]);
    return { start, end };
  }
  const single = parseFlexibleLocalDateTime(raw);
  return { start: single, end: single };
}

/**
 * Derive window columns for DB from AI pickup/delivery datetime strings.
 */
function inferWindowsFromAiDateTimeStrings(pickupDatetimeStr, deliveryDatetimeStr) {
  const pickupRange = parseRangeBoundaries(pickupDatetimeStr || '');
  const deliveryRange = parseRangeBoundaries(deliveryDatetimeStr || '');

  let pickup_window_start = pickupRange.start;
  let pickup_window_end = pickupRange.end;
  if (pickup_window_start && !pickup_window_end) {
    pickup_window_end = DateTime.fromJSDate(pickup_window_start, { zone: 'utc' })
      .plus({ hours: 6 })
      .toJSDate();
  }

  let delivery_window_start = deliveryRange.start;
  let delivery_window_end = deliveryRange.end;
  if (delivery_window_start && !delivery_window_end) {
    delivery_window_end = DateTime.fromJSDate(delivery_window_start, { zone: 'utc' })
      .plus({ hours: 6 })
      .toJSDate();
  }

  return {
    pickup_window_start,
    pickup_window_end,
    delivery_window_start,
    delivery_window_end,
  };
}

module.exports = {
  DEFAULT_ZONE,
  parseFlexibleLocalDateTime,
  parseRangeBoundaries,
  inferWindowsFromAiDateTimeStrings,
};
