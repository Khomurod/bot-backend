import React, { useEffect, useState } from "react";
import WebhookLinkSection from "./ViolationWebhookLink";

/**
 * Home-time violation alerts → the accounting group.
 *
 * A company driver who came home before 28 days on the road, or stayed home
 * more than 4 days (or their own rule, DriverRulesCard), is posted in the
 * group below with Charged / Not charging buttons for accounting. Since 11
 * November 2026 WENZE decides, from this page's own tracking (the Dispatcher
 * Board and the drivers' messages), and moves the driver's card in Bitrix's
 * "6. HOMETIME MONITORING" pipeline itself; the script that used to move the
 * cards is gone. Only home stays that begin after Wenze started are judged.
 *
 * Nothing is sent until a group is saved AND the switch is on. The webhook
 * link (ViolationWebhookLink) is only used when Bitrix decides again.
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
          {settings.violation_source === "bitrix" ? (
            <>The verdict comes from Bitrix&apos;s <b>6. HOMETIME MONITORING</b> pipeline.</>
          ) : (
            <>
              <b>Wenze decides</b> from its own home-time record (the Dispatcher Board — only HOME is home — and
              the drivers&apos; messages) and moves the driver&apos;s card in <b>6. HOMETIME MONITORING</b> itself.
              {settings.own_violations_since
                ? ` Judging home stays that began after ${new Date(settings.own_violations_since).toLocaleString()}.`
                : " The first check records when it starts; nothing earlier is judged."}
            </>
          )}
        </p>

        <WebhookLinkSection isSet={settings.violation_webhook_secret_set === true} />
      </div>
    </div>
  );
}
