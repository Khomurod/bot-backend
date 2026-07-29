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
  const [internalGroup, setInternalGroup] = useState(
    settings?.internal_clarification_group_id || ""
  );

  useEffect(() => {
    setNotifyGroup(settings?.completed_notify_group_id || "");
  }, [settings?.completed_notify_group_id]);

  useEffect(() => {
    setInternalGroup(settings?.internal_clarification_group_id || "");
  }, [settings?.internal_clarification_group_id]);

  if (!settings) return null;

  // Missing column on a pre-migration database means "on" — matches the backend.
  const driverMessaging = settings.driver_clarification_enabled !== false;

  const saveNotifyGroup = () => {
    const next = notifyGroup.trim();
    if (next === (settings.completed_notify_group_id || "")) return;
    onSave({ completed_notify_group_id: next });
  };

  const saveInternalGroup = () => {
    const next = internalGroup.trim();
    if (next === (settings.internal_clarification_group_id || "")) return;
    onSave({ internal_clarification_group_id: next });
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

        <hr style={{ border: 0, borderTop: "1px solid rgba(148,163,184,0.25)", margin: "4px 0" }} />

        <label>
          <input
            type="checkbox"
            checked={driverMessaging}
            onChange={(e) => onSave({ driver_clarification_enabled: e.target.checked })}
            disabled={saving}
          />{" "}
          Send clarification messages to driver groups
        </label>
        <p className="home-time-muted" style={{ margin: "-4px 0 0 24px" }}>
          {driverMessaging ? (
            <>
              On — the bot asks drivers directly for missing home-time dates, sends the two
              reminders, reacts 👍 and posts the policy response, exactly as before.
            </>
          ) : (
            <>
              <b>Off — the bot is silent in driver groups.</b> It still reads and analyses their
              messages, still detects genuine home-time requests, and still records the dates,
              status and AI reasoning. It sends no question, reminder, acknowledgment, reaction or
              policy warning to the driver, and already-scheduled reminders are stood down instead
              of being sent. If a driver mentions their dates anyway, the same request is updated
              silently and the approval card is posted once both dates are known. Staff are
              notified in the group below instead.
            </>
          )}
        </p>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Internal clarification notification group (Telegram chat ID)</label>
          <input
            className="form-input"
            type="text"
            inputMode="numeric"
            placeholder="e.g. -1001234567890 (leave empty to disable)"
            value={internalGroup}
            onChange={(e) => setInternalGroup(e.target.value)}
            onBlur={saveInternalGroup}
          />
          <p className="home-time-muted" style={{ margin: "6px 0 0" }}>
            While driver messaging is off, each new home-time request raises one alert here —
            tagging the approvers — with the driver and unit, the source group, the original
            message and a link to it, the detected intention, the dates found so far, the dates
            still missing, and why it was classified that way. One alert per request, never
            repeated. If this is empty the alert is skipped, but the request is still recorded and
            appears in the list above as <b>Awaiting staff clarification</b>.
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
