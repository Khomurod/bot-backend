import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { Banner } from "./fields";

// ────────────── Bonus Groups (Settings → Telegram Bot; was Telegram Groups) ──────

/**
 * The message categories, in display order. `key` is the API/DB category name —
 * it must match database/messageRoutingSettings.js CATEGORIES.
 */
const CATEGORIES = [
  {
    key: "mileageBonus",
    label: "Extra Mile / Mileage Bonus Telegram Group ID",
    help: "Milestone bonus cards (10k / 40k / 100k … driven miles) for company drivers, with Paid / Rejected buttons.",
  },
  {
    key: "roadBonus",
    label: "Extra Week / Road Bonus Telegram Group ID",
    help: "One summary posted when a company driver comes home after exceeding the road-week allowance (total extra weeks + total bonus).",
  },
];

/**
 * One labeled Telegram group-ID field. Unlike credentials these are NOT secrets,
 * so the current value is shown and editable in plaintext.
 */
function GroupIdField({ id, label, help, placeholder, value, onChange, status }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <label htmlFor={id} style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</label>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>{help}</div>
      <input
        id={id}
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

/** Pull the editable value of every category out of a loaded settings payload. */
function formFromSettings(settings) {
  return Object.fromEntries(CATEGORIES.map((c) => [c.key, settings?.[c.key]?.groupId || ""]));
}

const EMPTY_FORM = Object.fromEntries(CATEGORIES.map((c) => [c.key, ""]));

export default function TelegramGroupsTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.getMessageGroupSettings();
      setSettings(s);
      setForm(formFromSettings(s));
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const payload = Object.fromEntries(
        CATEGORIES.map((c) => [c.key, (form[c.key] || "").trim()])
      );
      const s = await api.updateMessageGroupSettings(payload);
      setSettings(s);
      setForm(formFromSettings(s));
      setMessage({ type: "success", text: "Telegram group settings saved." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  return (
    <div>
      <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
        The Telegram group each message category is sent to. Enter the group's chat ID
        (e.g. <code>-1001234567890</code>). Each category has its own destination — enter the
        same ID in more than one field to share a group. If a field is left blank, that
        category's messages are <strong>not sent</strong> and a configuration error is logged
        (there is no hidden default, and no category ever falls back to another).
      </p>
      <Banner message={message} />

      {CATEGORIES.map((c) => (
        <GroupIdField
          key={c.key}
          id={`group-id-${c.key}`}
          label={c.label}
          help={c.help}
          placeholder="e.g. -1001234567890"
          value={form[c.key]}
          onChange={(v) => setField(c.key, v)}
          status={settings?.[c.key]}
        />
      ))}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        {settings?.updatedAt && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Last updated {new Date(settings.updatedAt).toLocaleString()}</span>}
      </div>

      {/*
        Notification routing and the control channel used to sit here, on the
        argument that they are destinations too. They are Settings →
        Notifications now: both reported through THIS tab's banner, which is at
        the top, so saving a card at the bottom flashed "Saved." a screenful
        away from it — and the control channel is a two-way channel that changes
        operational state, not a message-category destination. What is left here
        is what this tab is named for: the routine per-workflow group ids.
      */}
    </div>
  );
}
