/**
 * What the Samsara driver-group switch says, in one place: the box in the
 * driver popup and the page message after a change must never disagree about
 * whether Off is really applied (docs/architecture/samsara-driver-group-alerts.md).
 */
export const NOT_APPLIED_YET =
  "Saved, but not applied yet: the Samsara service has not reported that it honours this switch "
  + "(its update is not deployed, or it has not checked in). Until it does, alerts still reach this group.";

/** The page message after a change — Off is reported as applied only when it is. */
export function samsaraSwitchMessage(enabled, enforced) {
  if (enabled) {
    return { type: "success", text: "Samsara alerts will be posted to this driver group again, from the next alert." };
  }
  if (enforced) {
    return {
      type: "success",
      text: "Samsara alerts are no longer posted to this driver group. The Samsara Notifications group still gets them.",
    };
  }
  return { type: "warning", text: NOT_APPLIED_YET };
}
