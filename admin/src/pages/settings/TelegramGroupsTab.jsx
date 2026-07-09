import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { Banner } from "./fields";

// ───────────────────────────── Telegram Groups tab ───────────────────────────

/**
 * One labeled Telegram group-ID field. Unlike credentials these are NOT secrets,
 * so the current value is shown and editable in plaintext.
 */
function GroupIdField({ label, help, placeholder, value, onChange, status }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</label>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>{help}</div>
      <input
        className="form-input"
        style={{ maxWidth: 320, fontFamily: "monospace" }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <div style={{ marginTop: 6 }}>
        {status?.configured ? (
          <span className="badge badge-active">
            ✓ Configured{status.fromEnv ? " (from environment)" : ""}
          </span>
        ) : (
          <span className="badge badge-inactive">✕ Not configured — messages will not be sent</span>
        )}
      </div>
    </div>
  );
}

export default function TelegramGroupsTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState({ mileageBonus: "", roadBonus: "", dispatchReview: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.getMessageGroupSettings();
      setSettings(s);
      setForm({
        mileageBonus: s.mileageBonus?.groupId || "",
        roadBonus: s.roadBonus?.groupId || "",
        dispatchReview: s.dispatchReview?.groupId || "",
      });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const s = await api.updateMessageGroupSettings({
        mileageBonus: form.mileageBonus.trim(),
        roadBonus: form.roadBonus.trim(),
        dispatchReview: form.dispatchReview.trim(),
      });
      setSettings(s);
      setForm({
        mileageBonus: s.mileageBonus?.groupId || "",
        roadBonus: s.roadBonus?.groupId || "",
        dispatchReview: s.dispatchReview?.groupId || "",
      });
      setMessage({ type: "success", text: "Telegram group settings saved." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        The Telegram group each message category is sent to. Enter the group's chat ID
        (e.g. <code>-1001234567890</code>). Each category has its own destination — enter the
        same ID in more than one field to share a group. If a field is left blank, that
        category's messages are <strong>not sent</strong> and a configuration error is logged
        (there is no hidden default).
      </p>
      <Banner message={message} />

      <GroupIdField
        label="Extra Mile / Mileage Bonus Telegram Group ID"
        help="Milestone bonus cards (10k / 40k / 100k … driven miles) for company drivers, with Paid / Rejected buttons."
        placeholder="e.g. -1001234567890"
        value={form.mileageBonus}
        onChange={(v) => setField("mileageBonus", v)}
        status={settings?.mileageBonus}
      />
      <GroupIdField
        label="Extra Week / Road Bonus Telegram Group ID"
        help="One summary posted when a company driver comes home after exceeding the road-week allowance (total extra weeks + total bonus)."
        placeholder="e.g. -1001234567890"
        value={form.roadBonus}
        onChange={(v) => setField("roadBonus", v)}
        status={settings?.roadBonus}
      />
      <GroupIdField
        label="72–75 CPM / Dispatch Rate Review Telegram Group ID"
        help="The weekly request asking dispatch to mark which drivers qualify for 72–75¢/mile, plus each team's submitted result summary."
        placeholder="e.g. -1001234567890"
        value={form.dispatchReview}
        onChange={(v) => setField("dispatchReview", v)}
        status={settings?.dispatchReview}
      />

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        {settings?.updatedAt && <span style={{ fontSize: 12, color: "#94a3b8" }}>Last updated {new Date(settings.updatedAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
