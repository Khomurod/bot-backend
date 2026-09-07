import React, { useEffect, useState } from "react";
import * as api from "../../../api";
import { KeyField } from "../fields";
import { cleanBitrixUserId } from "./bitrixUserId";

/**
 * Bitrix24 credentials and behaviour, entered here — not on the host.
 *
 * WHY. Every other integration (RingCentral, ELD, GMaps) is configured in
 * Settings; Bitrix alone lived in environment variables, so fixing a wrong
 * assignee id meant a Render deploy by whoever holds that dashboard. This
 * form writes the same encrypted single row those integrations use, and the
 * saved value wins over the environment variable from then on.
 *
 * THE WEBHOOK URL IS THE CREDENTIAL. It is a password field, blank keeps the
 * stored one, and the server only ever tells us the HOST it points at — the
 * URL never comes back to this page.
 *
 * THE ASSIGNEE FIELD is validated here, not just on the server: the production
 * mistake this replaces was a NAME in that slot, which Bitrix silently ignores.
 */
const seed = (s) => ({
  enabled: Boolean(s?.enabled),
  webhookUrl: "",
  clearWebhookUrl: false,
  entity: s?.entity === "deal" ? "deal" : "lead",
  assignedById: s?.assignedByIdRaw ?? (s?.assignedById != null ? String(s.assignedById) : ""),
  sourceId: s?.sourceId || "",
  sourceDescription: s?.sourceDescription || "",
  dealCategoryId: s?.dealCategoryId || "",
  dealStageId: s?.dealStageId || "",
  assigneeWaitSeconds: Math.round((s?.assigneeWaitMs ?? 25000) / 1000),
});

const label = { display: "block", fontWeight: 600, marginBottom: 4, fontSize: 13 };
const hint = { fontSize: 12, color: "#94a3b8", marginTop: 4 };

export default function BitrixSettingsForm({ settings, onSaved, onMessage }) {
  const [form, setForm] = useState(() => seed(settings));
  const [saving, setSaving] = useState(false);
  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // A save elsewhere (or a fresh load) changes what is stored; re-seed the
  // non-secret fields so the form never shows a stale assignee or entity.
  useEffect(() => { setForm((f) => ({ ...seed(settings), webhookUrl: f.webhookUrl })); }, [settings]);

  const save = async () => {
    const assignee = cleanBitrixUserId(form.assignedById);
    if (!assignee.ok) {
      onMessage?.({
        type: "error",
        text: `"${String(form.assignedById).trim()}" is not a Bitrix user id — use the number from the `
          + "profile URL (e.g. 17), or leave it blank so a Bitrix distribution rule assigns leads.",
      });
      return;
    }
    if (form.entity === "deal" && (!form.dealCategoryId.trim() || !form.dealStageId.trim())) {
      onMessage?.({ type: "error", text: "A deal needs both a category id and a stage id." });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        enabled: form.enabled,
        entity: form.entity,
        assignedById: assignee.value,
        sourceId: form.sourceId,
        sourceDescription: form.sourceDescription,
        dealCategoryId: form.dealCategoryId,
        dealStageId: form.dealStageId,
        assigneeWaitMs: Math.max(0, Number(form.assigneeWaitSeconds) || 0) * 1000,
      };
      if (form.clearWebhookUrl) payload.clearWebhookUrl = true;
      else if (form.webhookUrl.trim()) payload.webhookUrl = form.webhookUrl.trim();

      const saved = await api.updateBitrixSettings(payload);
      setForm((f) => ({ ...f, webhookUrl: "", clearWebhookUrl: false }));
      onMessage?.({ type: "success", text: "Bitrix24 settings saved." });
      onSaved?.(saved);
    } catch (err) {
      onMessage?.({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const webhookHint = settings?.webhookSet
    ? `set — points at ${settings.webhookHost || "an unparseable URL"}`
    : "not set";

  return (
    <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: "rgba(148,163,184,0.06)" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#cbd5e1", marginBottom: 8 }}>Bitrix24 connection</div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 10 }}>
        <input type="checkbox" checked={form.enabled} onChange={(e) => setField("enabled", e.target.checked)} />
        Send every Facebook lead to Bitrix24
        {settings?.fromEnv?.enabled && <span style={{ color: "#64748b", fontSize: 12 }}>(currently from environment)</span>}
      </label>

      <KeyField
        label="Inbound webhook URL"
        hint={webhookHint}
        fromEnv={settings?.webhookSet && settings?.fromEnv?.webhookUrl}
        value={form.webhookUrl}
        onChange={(v) => setField("webhookUrl", v)}
        placeholder="https://<portal>.bitrix24.com/rest/<user>/<token>/  — leave blank to keep current"
      />
      <div style={{ ...hint, marginTop: -4, marginBottom: 8 }}>
        From Bitrix → Developer resources → Inbound webhook, with the <code>crm</code> scope
        (and <code>user</code>, to enable the recruiter matcher). The URL is the credential:
        it is stored encrypted and never shown again — only its host is.
        {settings?.webhookSet && (
          <label style={{ display: "block", marginTop: 4 }}>
            <input type="checkbox" checked={form.clearWebhookUrl} onChange={(e) => setField("clearWebhookUrl", e.target.checked)} />
            {" "}Forget the stored webhook
          </label>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <div className="form-group">
          <label style={label}>Assignee at creation (Bitrix user ID)</label>
          <input
            className="form-input"
            inputMode="numeric"
            placeholder="blank = let a Bitrix rule assign"
            value={form.assignedById}
            onChange={(e) => setField("assignedById", e.target.value)}
          />
          <div style={hint}>
            Numeric only — from the profile URL <code>/company/personal/user/<strong>17</strong>/</code>.
            {settings?.assignedByIdIgnored && (
              <span style={{ color: "#f87171" }}>
                {" "}Currently "{settings.assignedByIdRaw}", which Bitrix ignores.
              </span>
            )}
          </div>
        </div>

        <div className="form-group">
          <label style={label}>Creates</label>
          <select className="form-input" value={form.entity} onChange={(e) => setField("entity", e.target.value)}>
            <option value="lead">lead</option>
            <option value="deal">deal</option>
          </select>
        </div>

        <div className="form-group">
          <label style={label}>Source ID</label>
          <input className="form-input" value={form.sourceId} placeholder="WEB" onChange={(e) => setField("sourceId", e.target.value)} />
        </div>

        <div className="form-group">
          <label style={label}>Source description</label>
          <input className="form-input" value={form.sourceDescription} onChange={(e) => setField("sourceDescription", e.target.value)} />
        </div>

        <div className="form-group">
          <label style={label}>Wait for a distribution rule (seconds)</label>
          <input
            className="form-input"
            type="number"
            min="0"
            style={{ maxWidth: 140 }}
            value={form.assigneeWaitSeconds}
            onChange={(e) => setField("assigneeWaitSeconds", e.target.value)}
          />
          <div style={hint}>How long the lead text waits for Bitrix to assign an owner before picking whose number sends. 0 = don't wait.</div>
        </div>

        {form.entity === "deal" && (
          <>
            <div className="form-group">
              <label style={label}>Deal category ID</label>
              <input className="form-input" value={form.dealCategoryId} onChange={(e) => setField("dealCategoryId", e.target.value)} />
            </div>
            <div className="form-group">
              <label style={label}>Deal stage ID</label>
              <input className="form-input" value={form.dealStageId} placeholder="e.g. C3:NEW" onChange={(e) => setField("dealStageId", e.target.value)} />
            </div>
          </>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save Bitrix24 settings"}
        </button>
        {settings?.updatedAt && (
          <span style={{ fontSize: 12, color: "#94a3b8" }}>Last saved {new Date(settings.updatedAt).toLocaleString()}</span>
        )}
      </div>
    </div>
  );
}
