/**
 * What the Samsara driver-group switch says, in one place: the box in the
 * driver popup and the page message after a change must never disagree about
 * whether Off is really applied (docs/architecture/samsara-driver-group-alerts.md).
 */
export const NOT_APPLIED_YET =
  "Saved, but not applied yet: the Samsara service has not reported that it honours this switch "
  + "(its update is not deployed, or it has not checked in). Until it does, alerts still reach this group.";

/** While the Samsara service's answer is not in yet: claims nothing either way. */
export const CHECKING = "Saved. Checking whether the Samsara service applies this switch…";

/**
 * The page message after a change. Off is reported as applied only when the
 * service said so (`true`), as not applied only when it said not (`false`),
 * and as unknown while it has not answered (`null`). It carries what it was
 * built from, so the page can rebuild it when a later answer differs.
 */
export function samsaraSwitchMessage(enabled, enforced) {
  const from = { source: "samsara", enabled, enforced };
  if (enabled) {
    return { ...from, type: "success", text: "Samsara alerts will be posted to this driver group again, from the next alert." };
  }
  if (enforced === true) {
    return {
      ...from,
      type: "success",
      text: "Samsara alerts are no longer posted to this driver group. The Samsara Notifications group still gets them.",
    };
  }
  if (enforced === false) return { ...from, type: "warning", text: NOT_APPLIED_YET };
  return { ...from, type: "info", text: CHECKING };
}

/**
 * A later answer about the Samsara service, applied to the message on screen:
 * a Samsara-switch message is rebuilt from the new answer; any other message
 * is left alone.
 */
export function refreshSamsaraMessage(message, enforced) {
  if (message?.source !== "samsara" || message.enforced === enforced) return message;
  return samsaraSwitchMessage(message.enabled, enforced);
}
