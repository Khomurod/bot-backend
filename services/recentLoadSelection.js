/**
 * Pick which stored load row should drive ETA/status for "now".
 * Prefers a row whose overall pickup→delivery window contains `now`,
 * otherwise the newest row (first in DESC-by-created order).
 */
function pickStoredLoadForContext(rows, now = new Date()) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const sorted = [...rows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const t = now.getTime();

  for (const row of sorted) {
    if (isNowWithinOverallLoadSpan(row, now)) {
      return row;
    }
  }

  return sorted[0];
}

function isNowWithinOverallLoadSpan(row, now) {
  const t = now.getTime();

  const ps = row.pickup_window_start ? new Date(row.pickup_window_start).getTime() : null;
  const de = row.delivery_window_end
    ? new Date(row.delivery_window_end).getTime()
    : null;

  if (ps != null && de != null && !Number.isNaN(ps) && !Number.isNaN(de) && ps <= de) {
    return t >= ps && t <= de;
  }

  const ps2 = row.pickup_window_start ? new Date(row.pickup_window_start).getTime() : null;
  const pe = row.pickup_window_end ? new Date(row.pickup_window_end).getTime() : null;
  const ds = row.delivery_window_start ? new Date(row.delivery_window_start).getTime() : null;
  const de2 = row.delivery_window_end ? new Date(row.delivery_window_end).getTime() : null;

  const spanStart = ps2 ?? ds ?? null;
  const spanEnd = de2 ?? pe ?? null;

  if (spanStart != null && spanEnd != null && !Number.isNaN(spanStart) && !Number.isNaN(spanEnd) && spanStart <= spanEnd) {
    return t >= spanStart && t <= spanEnd;
  }

  return false;
}

module.exports = {
  pickStoredLoadForContext,
  isNowWithinOverallLoadSpan,
};
