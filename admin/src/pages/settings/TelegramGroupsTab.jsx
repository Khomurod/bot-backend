import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../../api";
import { Banner } from "./fields";

// ───────────────────────────── Telegram Groups tab ───────────────────────────

/**
 * The message categories, in display order. `key` is the API/DB category name —
 * it must match database/messageRoutingSettings.js CATEGORIES.
 *
 * The two driver-raise rows are separate on purpose: the REQUEST goes out to
 * dispatch, the finished RESULT comes back for accounting. The wording spells
 * out the direction and the audience of each so the two IDs cannot be swapped by
 * accident.
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
  {
    key: "dispatchReview",
    label: "① Dispatch Rate Review — REQUESTS Telegram Group ID",
    help: "Where the bot ASKS FOR the review. The weekly (and \"Send now\") 72–75¢/mile message with the link"
      + " dispatchers open to mark which of their drivers qualify. Put your DISPATCH team's group here."
      + " Nothing about pay decisions is posted to this group.",
  },
  {
    key: "raiseResults",
    label: "② Driver Raise Results → ACCOUNTING Telegram Group ID",
    help: "Where the bot SENDS THE ANSWER. After a dispatch team submits its review, the finished decision"
      + " (who moves to the higher rate, who stays at the lower one, plus team, submitter and pay period)"
      + " is posted here — and only here. Put your ACCOUNTING / payroll group here, not the dispatch group,"
      + " unless you really want dispatch to see every pay decision.",
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
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>{help}</div>
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

  // Using one group for both raise steps is allowed, but it means dispatch also
  // sees every pay decision — so say so out loud rather than silently accepting it.
  const raiseGroupsShared = useMemo(() => {
    const dispatch = (form.dispatchReview || "").trim();
    const results = (form.raiseResults || "").trim();
    return Boolean(dispatch) && dispatch === results;
  }, [form.dispatchReview, form.raiseResults]);

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
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        The Telegram group each message category is sent to. Enter the group's chat ID
        (e.g. <code>-1001234567890</code>). Each category has its own destination — enter the
        same ID in more than one field to share a group. If a field is left blank, that
        category's messages are <strong>not sent</strong> and a configuration error is logged
        (there is no hidden default, and no category ever falls back to another).
      </p>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        The <strong>Driver Raise Review</strong> uses the last two fields as a pair:
        <strong> ① </strong>is the group that is <em>asked</em> to fill in the review, and
        <strong> ② </strong>is the group that <em>receives the finished pay decision</em>.
        They are two different audiences — check you have not swapped them.
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

      {raiseGroupsShared && (
        <div className="alert alert-warning" style={{ marginBottom: 16 }}>
          ⚠ Both driver-raise fields point at the same group, so the dispatch team that fills in
          the review will also see the finished pay decision. That is allowed — leave it if you
          meant it, or give ② your accounting group.
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        {settings?.updatedAt && <span style={{ fontSize: 12, color: "#94a3b8" }}>Last updated {new Date(settings.updatedAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
