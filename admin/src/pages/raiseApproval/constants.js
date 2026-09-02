/**
 * Weekday options for the auto-send schedule.
 *
 * The values are ISO weekday numbers (1 = Monday … 7 = Sunday), matching what
 * services/scheduledMessageUtils.js compares against — it validates 1..7 and
 * diffs the stored value against Luxon's `weekday`. NOT JavaScript's getDay(),
 * where Sunday is 0: sending 0 from here would fail validation and silently
 * leave next_run_at null, so the weekly review would simply never go out.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export const WEEKDAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];
