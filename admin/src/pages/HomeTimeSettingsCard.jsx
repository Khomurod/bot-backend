import React, { useEffect, useState } from "react";

function money(value) {
  return `$${Number(value || 0).toFixed(0)}`;
}

/**
 * Home-time settings card. Extracted from HomeTimePage so both stay within the
 * project's per-file line limit. Numeric fields save on blur; the completed-
 * request notification group saves on blur too.
 *
 * The notification group is the Telegram chat that receives COMPLETED home-time
 * request cards. Completed cards are never posted to the driver's own group —
 * only the date-clarification asks and the under-allowance policy reminder are.
 */
export default function HomeTimeSettingsCard({ settings, saving, onSave }) {
  const [notifyGroup, setNotifyGroup] = useState(settings?.completed_notify_group_id || "");

  useEffect(() => {
    setNotifyGroup(settings?.completed_notify_group_id || "");
  }, [settings?.completed_notify_group_id]);

  if (!settings) return null;

  const saveNotifyGroup = () => {
    const next = notifyGroup.trim();
    if (next === (settings.completed_notify_group_id || "")) return;
    onSave({ completed_notify_group_id: next });
  };

  return (
    <div className="card" style={{ marginTop: 20, marginBottom: 20 }}>
      <h3>Settings</h3>
      <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
        <label>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => onSave({ enabled: e.target.checked })}
            disabled={saving}
          />{" "}
          Tracking enabled
        </label>
        <div className="home-time-form-grid">
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Weeks allowed on the road</label>
            <input
              className="form-input"
              type="number"
              min="1"
              max="52"
              defaultValue={settings.road_allowance_weeks}
              onBlur={(e) => onSave({ road_allowance_weeks: Number(e.target.value) })}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Days allowed at home</label>
            <input
              className="form-input"
              type="number"
              min="1"
              max="60"
              defaultValue={settings.home_allowance_days}
              onBlur={(e) => onSave({ home_allowance_days: Number(e.target.value) })}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Bonus per extra week ($)</label>
            <input
              className="form-input"
              type="number"
              min="0"
              step="1"
              defaultValue={settings.bonus_per_week}
              onBlur={(e) => onSave({ bonus_per_week: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Completed-request notification group (Telegram chat ID)</label>
          <input
            className="form-input"
            type="text"
            inputMode="numeric"
            placeholder="e.g. -1001234567890 (leave empty to disable)"
            value={notifyGroup}
            onChange={(e) => setNotifyGroup(e.target.value)}
            onBlur={saveNotifyGroup}
          />
          <p className="home-time-muted" style={{ margin: "6px 0 0" }}>
            Completed home-time request cards (with Approve / Do Not Approve) are posted to
            this group only — never to the driver's own group. When it is empty, the completed
            card is not posted anywhere (the request still appears here in the admin panel).
            Date-clarification questions and the under-{settings.road_allowance_weeks}-week reminder
            still go to the driver's group as before.
          </p>
        </div>

        <p className="home-time-muted" style={{ margin: 0 }}>
          Company-driver policy: at least {settings.road_allowance_weeks} weeks on the road, then{" "}
          {settings.home_allowance_days} days home. Each full extra road week earns{" "}
          {money(settings.bonus_per_week)} for company drivers only. Owner operators stay visible for tracking but
          do not accrue the company bonus.
        </p>
      </div>
    </div>
  );
}
