/**
 * What the Home Time → Efficiency screen and its company card share. PURE.
 * Split out of HomeTimeEfficiencyTab.jsx (November 2026).
 */
// Category palette — colorblind-safe and NOT relied on alone (every chart segment
// and table badge also carries a text label + count + %). Matches the request
// status colors used elsewhere on the page for consistency.
export const CATEGORY_META = {
  compliant: { label: "Policy compliant", color: "var(--success)" },
  approved_exception: { label: "Approved exception", color: "var(--info)" },
  non_compliant: { label: "Policy not followed", color: "var(--danger)" },
  incomplete: { label: "Incomplete data", color: "var(--text-muted)" },
  not_applicable: { label: "Policy not applicable", color: "var(--accent-text)" },
};

// Company-commitment verdicts: did what actually happened match the approved
// (registered) home dates? Kept text-labelled (never color-only).
export const COMMITMENT_META = {
  met: { label: "Commitment met", color: "var(--success)" },
  broken: { label: "Commitment broken", color: "var(--danger)" },
  incomplete: { label: "Awaiting return", color: "var(--text-muted)" },
  none: { label: "No approved dates", color: "var(--text-muted)" },
  not_applicable: { label: "N/A", color: "var(--accent-text)" },
};

export const RANGES = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 180 days" },
  { value: "all", label: "All time" },
];

export function pctLabel(value) {
  return value == null ? "--" : `${value}%`;
}
