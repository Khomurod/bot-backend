import React from "react";
import { WEEKDAYS } from "./constants";

/**
 * The Driver Raise settings card.
 *
 * Presentational: every control calls a handler from useRaiseSettings, which
 * owns the save and the status message. Note the mix of onChange and onBlur —
 * the toggles and selects save immediately, the three numeric rate/TTL fields
 * save on blur via defaultValue so typing "0.7" does not fire a save at "0".
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function SettingsCard({
  settings, scheduleDescription, savingSettings, saveSettings,
  gmailUser, setGmailUser, gmailPassword, setGmailPassword,
  savingGmail, saveGmail,
}) {
  return (

  <div className="card" style={{ marginBottom: 20 }}>
    <h3>Settings</h3>
    {settings && (
      <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
        <label>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => saveSettings({ enabled: e.target.checked })}
            disabled={savingSettings}
          />{" "}
          Service enabled
        </label>

        <div className="form-group">
          <label>Verification code is sent by</label>
          <select
            value={settings.otp_channel}
            onChange={(e) => saveSettings({ otp_channel: e.target.value })}
            disabled={savingSettings}
          >
            <option value="gmail">Email (your Gmail)</option>
            <option value="ringcentral">Text message (RingCentral SMS)</option>
          </select>
        </div>

        {settings.otp_channel === "gmail" && (
          <div style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
            <div style={{ fontWeight: 600 }}>
              Gmail credentials{" "}
              <span style={{ fontWeight: 400, color: settings.gmail_configured ? "#16a34a" : "#dc2626" }}>
                {settings.gmail_configured ? "— configured ✓" : "— not configured"}
              </span>
            </div>
            <p style={{ color: "#888", margin: 0 }}>
              Use a Gmail <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">App Password</a> (not
              your normal password). The password is encrypted before it is stored.
            </p>
            <div className="form-group">
              <label>Gmail address</label>
              <input
                type="email"
                placeholder="dispatch@company.com"
                value={gmailUser}
                onChange={(e) => setGmailUser(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>App Password</label>
              <input
                type="password"
                placeholder={settings.gmail_configured ? "Leave blank to keep current" : "16-character App Password"}
                value={gmailPassword}
                onChange={(e) => setGmailPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div>
              <button className="btn btn-primary" onClick={saveGmail} disabled={savingGmail}>
                {savingGmail ? "Saving…" : "Save email settings"}
              </button>
            </div>
          </div>
        )}

        <label>
          <input
            type="checkbox"
            checked={settings.schedule_enabled}
            onChange={(e) => saveSettings({ schedule_enabled: e.target.checked })}
            disabled={savingSettings}
          />{" "}
          Auto-send on a weekly schedule
        </label>

        {settings.schedule_enabled && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              value={settings.weekly_day_of_week}
              onChange={(e) => saveSettings({ weekly_day_of_week: Number(e.target.value) })}
              disabled={savingSettings}
            >
              {WEEKDAYS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
            <input
              type="time"
              value={settings.weekly_time_local}
              onChange={(e) => saveSettings({ weekly_time_local: e.target.value })}
              disabled={savingSettings}
            />
            <span style={{ color: "var(--muted, #888)" }}>{scheduleDescription}</span>
          </div>
        )}

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div className="form-group">
            <label>Base rate ($/mile)</label>
            <input
              type="number" step="0.01" defaultValue={settings.rate_low}
              onBlur={(e) => saveSettings({ rate_low: Number(e.target.value) })}
            />
          </div>
          <div className="form-group">
            <label>Raised rate ($/mile)</label>
            <input
              type="number" step="0.01" defaultValue={settings.rate_high}
              onBlur={(e) => saveSettings({ rate_high: Number(e.target.value) })}
            />
          </div>
          <div className="form-group">
            <label>Link expires after (hours)</label>
            <input
              type="number" min="1" max="720" defaultValue={settings.link_ttl_hours}
              onBlur={(e) => saveSettings({ link_ttl_hours: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>
    )}
  </div>
  );
}
