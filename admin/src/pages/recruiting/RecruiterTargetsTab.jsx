import React, { useEffect, useState } from "react";
import { NumField, Banner } from "../settings/fields";
import PageFailure from "../../components/PageFailure";
import useRingCentralSettings from "../settings/ringcentral/useRingCentralSettings";

/**
 * Recruiter KPIs → Targets (`#recruiter_kpis/targets`): what a recruiter's day
 * is scored against, and which calls count.
 *
 * Moved here from the RingCentral settings screen in November 2026, next to
 * the numbers it scores; the KPI page used to send people to Settings to
 * change them. They are still fields of the shared RingCentral settings row,
 * and Save sends ONLY these, so it can never write back a stale copy of the
 * credentials (useRingCentralSettings).
 */
const FIELDS = [
  "targetTalkMinutes", "targetOutbound", "targetRealConversations",
  "nonValuableMaxSeconds", "realConversationMinSeconds", "strongConversationMinSeconds",
];

export default function RecruiterTargetsTab({ onSaved }) {
  const { settings, loading, loadError, load, save } = useRingCentralSettings();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (!settings) return;
    setForm({
      targetTalkMinutes: settings.targetTalkMinutes ?? 150,
      targetOutbound: settings.targetOutbound,
      targetRealConversations: settings.targetRealConversations,
      nonValuableMaxSeconds: settings.nonValuableMaxSeconds,
      realConversationMinSeconds: settings.realConversationMinSeconds,
      strongConversationMinSeconds: settings.strongConversationMinSeconds,
      timezone: settings.timezone || "America/Chicago",
    });
  }, [settings]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onSave = async () => {
    setSaving(true); setMessage(null);
    try {
      const payload = { timezone: form.timezone };
      for (const k of FIELDS) payload[k] = Number(form[k]);
      await save(payload);
      setMessage({ type: "success", text: "Targets saved." });
      onSaved?.();
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;
  if (!settings || !form) return <PageFailure error={loadError} where="the recruiter targets" onRetry={load} />;

  return (
    <div>
      <Banner message={message} />
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Daily Targets &amp; Conversation Thresholds</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
          The main KPI is real call time per recruiter per day — calls shorter than the minimum
          below do not count. The secondary KPI is outbound calls per day.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <div>
            <NumField label="Real talk-time target (main KPI)" value={form.targetTalkMinutes} onChange={(v) => setField("targetTalkMinutes", v)} suffix="minutes/day" />
            <NumField label="Total Outbound target (secondary)" value={form.targetOutbound} onChange={(v) => setField("targetOutbound", v)} suffix="calls/day" />
            <NumField label="Real Conversations target" value={form.targetRealConversations} onChange={(v) => setField("targetRealConversations", v)} suffix="calls/day" />
          </div>
          <div>
            <NumField label="Minimum call duration counted toward talk time" value={form.nonValuableMaxSeconds} onChange={(v) => setField("nonValuableMaxSeconds", v)} suffix="seconds" />
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -6, marginBottom: 10, maxWidth: 320 }}>
              Calls shorter than this threshold do not count toward real talk time. Default: 30 seconds.
            </div>
            <NumField label="Real conversation (over)" value={form.realConversationMinSeconds} onChange={(v) => setField("realConversationMinSeconds", v)} suffix="seconds" />
            <NumField label="Strong conversation (over)" value={form.strongConversationMinSeconds} onChange={(v) => setField("strongConversationMinSeconds", v)} suffix="seconds" />
          </div>
          <div>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4, fontSize: 13 }}>Day timezone</label>
              <input className="form-input" style={{ maxWidth: 200 }} value={form.timezone} onChange={(e) => setField("timezone", e.target.value)} />
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 24 }}>
        <button className="btn btn-primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save targets"}</button>
        {settings.updatedAt && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Last updated {new Date(settings.updatedAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
