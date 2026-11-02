/**
 * The words on the Birthdays → Birthdays tab: the posting time, what a send
 * did, and what each confirm says before it posts. Pure, so the page and its
 * tests read the same text.
 */
import { friendlyTimezone } from "../../utils/formatTime";

export const DEFAULT_TIMEZONE = "Asia/Tashkent";

export const TIMEZONE_OPTIONS = [
  "Asia/Tashkent",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "UTC",
];

export function formatSchedule(settings) {
  if (!settings) return "";
  const h = String(settings.sendHour ?? 0).padStart(2, "0");
  const m = String(settings.sendMinute ?? 0).padStart(2, "0");
  const tz = settings.timezone || DEFAULT_TIMEZONE;
  return `${h}:${m} ${friendlyTimezone(tz)} (${tz})`;
}

export function wishResultMessage(result) {
  if (!result) return "Done.";
  if (result.sent) {
    return `Posted the birthday card(s) to the employee group for: ${result.names}.`;
  }
  if (result.reason === "already_sent") {
    return `Already sent today (${result.isoDate}). Scheduled run will be skipped.`;
  }
  if (result.reason === "no_birthdays") {
    return "No employees have a birthday today in the configured timezone.";
  }
  if (result.reason === "no_employee_group") {
    return "EMPLOYEE_GROUP_ID is not configured.";
  }
  return result.reason || "No action taken.";
}

/** Title, body and button for the confirm in front of each action. */
export function confirmCopy(action) {
  switch (action?.type) {
    case "delete":
      return {
        title: "🗑️ Remove Employee?",
        body: "This will permanently remove this employee from the birthday list.",
        label: "Remove",
        danger: true,
      };
    case "sendToday":
      return {
        title: "🎂 Send Birthday Wishes?",
        body: "This posts today's birthday cards to the employee group now; the scheduled send will not post them again.",
        label: "Send",
      };
    case "congratulate":
      return {
        title: `🎂 Congratulate ${action.ids?.length} Employee(s)?`,
        body: `Each selected employee's birthday card will be posted to the employee group (${action.ids?.length}).`,
        label: "Send",
      };
    case "custom":
      return {
        title: "💬 Send Custom Message?",
        body: "This sends your custom message to the employee group.",
        label: "Send",
      };
    case "request":
      return {
        title: "💬 Request Birthdays?",
        body: "This sends a message asking all employees for their birthdays.",
        label: "Send",
      };
    default:
      return { title: "Confirm", body: "Are you sure?", label: "Send" };
  }
}
