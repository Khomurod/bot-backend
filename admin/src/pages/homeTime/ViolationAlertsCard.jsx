import React, { useEffect, useState } from "react";

/**
 * Home-time violation alerts — Bitrix pipeline 33 → the accounting group.
 *
 * A company driver who came home before 28 days on the road, or stayed home
 * more than 4 days, is posted in the group below with Charged / Not charging
 * buttons for accounting. The verdict comes from Bitrix's "6. HOMETIME
 * MONITORING" pipeline, not from this page's own tracking.
 *
 * Nothing is sent until a group is saved AND the switch is on. Switching on
 * records every card already in a violation stage without posting it. The
 * webhook secret is set in the server's environment; this card only says
 * whether it is.
 */
export default function ViolationAlertsCard({ settings, saving, onSave }) {
  const [group, setGroup] = useState(settings?.violation_alerts_chat_id || "");

  useEffect(() => {
    setGroup(settings?.violation_alerts_chat_id || "");
  }, [settings?.violation_alerts_chat_id]);

  if (!settings) return null;

  const enabled = settings.violation_alerts_enabled === true;
  const saved = settings.violation_alerts_chat_id || "";

  const saveGroup = () => {
    const next = group.trim();
    if (next === saved) return;
    onSave({ violation_alerts_chat_id: next });
  };

  return (
    <div className="card" style={{ marginTop: 20, marginBottom: 20 }}>
      <h3>Home-time violation alerts (accounting)</h3>
      <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="ht-violation-group">Alerts group (Telegram chat ID)</label>
          <input
            id="ht-violation-group"
            className="form-input"
            type="text"
            inputMode="numeric"
            placeholder="e.g. -1001234567890"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            onBlur={saveGroup}
          />
          <p className="home-time-muted" style={{ margin: "6px 0 0" }}>
            The group is checked before it is saved. Clearing it switches the alerts off.
          </p>
        </div>

        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onSave({ violation_alerts_enabled: e.target.checked })}
            disabled={saving || (!saved && !enabled)}
          />{" "}
          Post violation alerts
        </label>
        <p className="home-time-muted" style={{ margin: "-4px 0 0 24px" }}>
          A company driver who came home before 28 days on the road, or stayed home more than 4
          days, is posted here once per home stay, tagging accounting, with <b>✅ Charged</b> and{" "}
          <b>❌ Not charging</b> buttons (accounting only; "not charging" asks for a reason).
          The verdict comes from Bitrix's <b>6. HOMETIME MONITORING</b> pipeline. Switching on
          records every card already in a violation stage <b>without posting it</b>
          {settings.violation_alerts_baselined_at ? " — done for the current switch-on." : "."}
        </p>

        <p className="home-time-muted" style={{ margin: 0 }}>
          Bitrix webhook secret:{" "}
          <b>{settings.violation_webhook_secret_set ? "set" : "not set"}</b>
          {settings.violation_webhook_secret_set
            ? " (in the server environment; it is never shown here)."
            : " — set HOME_TIME_VIOLATION_WEBHOOK_SECRET in the server environment. Without it the Bitrix robot is refused and alerts arrive only from the 30-minute check."}
        </p>
      </div>
    </div>
  );
}
