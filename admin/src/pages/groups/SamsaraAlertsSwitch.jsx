import React from "react";

import { CHECKING, NOT_APPLIED_YET } from "./samsaraSwitchText";

/**
 * Driver details → "Samsara alerts in this group": whether the Samsara
 * service ALSO posts its safety and speeding alerts into this driver's own
 * Telegram group.
 *
 * Only the driver-group copy is switched. The Samsara Notifications group and
 * every subscriber still get each alert, and the event is still recorded — the
 * help line says so, because "off" must not read as "Samsara is off for this
 * driver". docs/architecture/samsara-driver-group-alerts.md has the rules.
 *
 * Saves the moment it is changed, like the rest of this modal. A company chat
 * shows nothing: Samsara never posts to one. `team` is the modal's own answer
 * (`shouldShowTeamInputs`), so this cannot disagree with the team fields.
 *
 * IT NEVER CLAIMS MORE THAN IS TRUE. The switch is enforced by the separate
 * Samsara service, which deploys on its own. `enforced` comes from that
 * service's heartbeat. Off reads "not posted here" only when it said true,
 * "saved, but not applied yet" when it said false, and "checking" — no claim
 * either way — while it has not answered.
 */
export default function SamsaraAlertsSwitch({ profile, saving, onChange, team = false, enforced = null }) {
  const labelId = React.useId();
  if (!profile || (profile.group_type && profile.group_type !== "driver")) return null;

  const enabled = profile.samsara_driver_alerts_enabled !== false;

  return (
    <div
      role="group" aria-labelledby={labelId}
      style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, margin: 0 }}>
          <input
            type="checkbox" role="switch" aria-checked={enabled} checked={enabled} disabled={saving}
            onChange={(e) => onChange(profile, e.target.checked)}
          />
          <span id={labelId}>Samsara alerts in this group</span>
        </label>
        <span className={`badge ${enabled ? "badge-active" : "badge-warning"}`}>{enabled ? "On" : "Off"}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
        {enabled ? (
          <>Each Samsara safety or speeding alert routed to this driver is posted here, as well as to the Samsara Notifications group.</>
        ) : enforced === false ? (
          <span role="status" style={{ color: "var(--warning)" }}>{NOT_APPLIED_YET}</span>
        ) : enforced !== true ? (
          <span role="status">{CHECKING}</span>
        ) : (
          <>
            Not posted here. The Samsara Notifications group and its subscribers still get every alert for this
            driver, and the event is still recorded. Switching it back on applies from the next alert.
          </>
        )}
        {team && <> Team drivers share this group, so this applies to both of them.</>}
        {profile.group_active === false && (
          <> This group is inactive, so Samsara does not post to it at the moment either way.</>
        )}
      </div>
    </div>
  );
}
