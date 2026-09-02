import { isCompanyDriver } from "../homeTimeViewModel";

/**
 * How a Home Time row reads in the admin panel — pure label and formatting
 * rules, no I/O and no React.
 *
 * OWNER OPERATORS ARE NOT SHORT ON POLICY, they are outside it: the road
 * allowance and the mileage bonus apply to company drivers only, so these
 * helpers say "N/A for owner operator" rather than computing a compliance
 * verdict that would read as a violation.
 *
 * requestStatusMeta distinguishes the INTERNAL clarification channel: when the
 * bot may not message driver groups, an awaiting-dates request is waiting on
 * staff, not on the driver, and labelling it "waiting on driver" would send
 * someone chasing a driver who was never asked.
 *
 * Split out of admin/src/pages/HomeTimePage.jsx.
 */
export function fmtDate(iso) {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export function toDateInput(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return String(iso).slice(0, 10);
  }
}

export function money(value) {
  return `$${Number(value || 0).toFixed(0)}`;
}

// An awaiting_* request whose clarification is being handled by staff (because
// the bot is not messaging driver groups) reads as "Awaiting staff clarification".
// The stored status value is unchanged — only the label differs — so all the
// reminder and completion logic that keys off awaiting_* is untouched.
export const AWAITING_STATUSES = ["awaiting_dates", "awaiting_home_start", "awaiting_return_to_road"];

export function requestStatusMeta(status, clarificationChannel) {
  if (clarificationChannel === "internal" && AWAITING_STATUSES.includes(status)) {
    return {
      label: "Awaiting staff clarification",
      color: "#c084fc",
      background: "rgba(192, 132, 252, 0.14)",
    };
  }
  switch (status) {
    case "approved":
      return { label: "Approved", color: "#22c55e", background: "rgba(34, 197, 94, 0.14)" };
    case "denied":
      return { label: "Denied", color: "#ef4444", background: "rgba(239, 68, 68, 0.14)" };
    case "cancelled":
      return { label: "Cancelled", color: "#94a3b8", background: "rgba(148, 163, 184, 0.14)" };
    case "expired":
      return { label: "Expired — No Action", color: "#a78bfa", background: "rgba(167, 139, 250, 0.14)" };
    case "clarification_unanswered":
      return { label: "No response", color: "#fb923c", background: "rgba(251, 146, 60, 0.14)" };
    case "awaiting_dates":
      return { label: "Awaiting dates", color: "#38bdf8", background: "rgba(56, 189, 248, 0.14)" };
    case "awaiting_home_start":
      return { label: "Awaiting arrive-home date", color: "#38bdf8", background: "rgba(56, 189, 248, 0.14)" };
    case "awaiting_return_to_road":
      return { label: "Awaiting return date", color: "#38bdf8", background: "rgba(56, 189, 248, 0.14)" };
    case "pending":
      return { label: "Pending decision", color: "#f59e0b", background: "rgba(245, 158, 11, 0.14)" };
    default:
      return { label: status ? String(status) : "Unknown", color: "#94a3b8", background: "rgba(148, 163, 184, 0.14)" };
  }
}

export function policyLabel(driverType, policyMet) {
  if (!isCompanyDriver(driverType)) return "N/A for owner operator";
  if (policyMet === true) return "Policy met";
  if (policyMet === false) return "Policy short";
  return "Policy not evaluated";
}

export function nextHomeLabel(status) {
  if (!status) return "--";
  if (status.state === "home") return "Already home";
  if (!isCompanyDriver(status.driver_type)) return "N/A for owner operator";
  if (!status.next_home_time_date) return "--";
  return `${fmtDate(status.next_home_time_date)}${status.over_limit ? " (eligible now)" : ""}`;
}

export function currentCycleLabel(status) {
  if (!status) return "--";
  return status.state === "road"
    ? `${status.days_on_road}d on road`
    : `${status.days_home}d at home`;
}

export function bonusProgressLabel(status) {
  if (!status || status.state !== "road") return "No active road cycle";
  if (!isCompanyDriver(status.driver_type)) return "Owner operator - no company bonus";
  if (!status.over_limit) return "Within company road allowance";
  return `${status.pending_exceeded_weeks} extra week(s) building ${money(status.pending_bonus_usd)}`;
}

export function activityTitle(item) {
  if (item.kind === "request") {
    return `${requestStatusMeta(item.status, item.clarification_channel).label} home-time request`;
  }
  return "Completed road cycle";
}

export function sortArrow(active, direction) {
  if (!active) return "<>";
  return direction === "asc" ? "^" : "v";
}
