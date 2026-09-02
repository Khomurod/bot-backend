/**
 * Auto-message constants and the pure row/label helpers the tabs render with.
 *
 * WEEKDAYS uses ISO numbering (1 = Monday … 7 = Sunday), matching what the
 * server stores in days_of_week — not JavaScript's getDay(), where Sunday
 * is 0.
 *
 * No I/O and no React here, so the default rule template and the status-pill
 * mapping stay testable on their own.
 *
 * Split out of admin/src/pages/FacebookLeadsPage.jsx.
 */
export const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

export const TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "UTC",
];

export function emptyRule(sortOrder = 0) {
  return {
    label: `Rule ${sortOrder + 1}`,
    days_of_week: [1, 2, 3, 4, 5],
    start_time_local: "08:00",
    end_time_local: "17:00",
    message_template: (
      "Hello {first_name}, this is {rep_name} with {company_name} "
      + "and thanks for applying to our {position}. "
      + "Can I call you right now to explain the details?"
    ),
    sort_order: sortOrder,
    is_active: true,
  };
}

export function mapPreviewResult(result) {
  if (!result) return null;
  return {
    rendered: result.rendered || "",
    rule_label: result.rule_label || "",
    source: result.source || "",
    segments: result.segments || null,
    timezone: result.timezone || "",
    timezone_friendly: result.timezone_friendly || "",
    evaluated_at_iso: result.evaluated_at_iso || null,
  };
}

export function statusPillClass(status) {
  switch ((status || "").toLowerCase()) {
    case "processed": return "status-pill status-pill--success";
    case "failed": return "status-pill status-pill--danger";
    case "pending": return "status-pill status-pill--warning";
    default: return "status-pill status-pill--neutral";
  }
}

export function shortenId(id) {
  if (id == null) return "—";
  const s = String(id);
  return s.length > 8 ? `#${s.slice(-6)}` : `#${s}`;
}
