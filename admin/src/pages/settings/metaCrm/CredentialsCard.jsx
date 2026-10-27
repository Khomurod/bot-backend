import React, { useState } from "react";
import * as api from "../../../api";
import CheckList from "./CheckList";
import { canSave, formFingerprint } from "./testGate";

/**
 * Enter → Test → Save. Save stays disabled until a Test passed with exactly
 * the values in the form; any edit locks it again (./testGate.js). The server
 * proves the token once more on Save and refuses what fails (a warning saves).
 *
 * The token box is write-only: empty means "keep the token in use". The test
 * event code is used by Test only and never saved.
 */
export default function CredentialsCard({ settings, onSaved }) {
  const [form, setForm] = useState({ datasetId: settings.datasetId || "", token: "", testEventCode: "" });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [tested, setTested] = useState(null); // { fingerprint, passed }
  const [message, setMessage] = useState(null);

  const setField = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setMessage(null); };

  const runTest = async () => {
    setTesting(true); setMessage(null); setResult(null);
    const fingerprint = formFingerprint(form);
    try {
      const r = await api.testMetaCrmSettings(form);
      setResult(r);
      setTested({ fingerprint, passed: Boolean(r.passed) });
    } catch (err) {
      setTested(null);
      setMessage({ type: "error", text: err.message });
    } finally { setTesting(false); }
  };

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const saved = await api.saveMetaCrmSettings({ datasetId: form.datasetId, token: form.token });
      // The token never lives in this form longer than one save.
      setForm((f) => ({ ...f, token: "" }));
      setTested(null);
      setResult(null);
      setMessage({ type: "success", text: "Saved, and the sync is on. The next pass (within 15 minutes) uses these values — no restart needed." });
      onSaved(saved);
    } catch (err) {
      setTested(null);
      setMessage({ type: "error", text: err.message });
    } finally { setSaving(false); }
  };

  const saveAllowed = canSave(tested, form) && !saving && !testing;
  const edited = tested && tested.fingerprint !== formFingerprint(form);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Credentials</h3>
      <div className="form-group">
        <label htmlFor="meta-crm-dataset" style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Dataset ID</label>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>Events Manager → your CRM dataset → Settings. Digits only.</div>
        <input id="meta-crm-dataset" className="form-input" inputMode="numeric" value={form.datasetId}
          placeholder="e.g. 1234567890123456" onChange={(e) => setField("datasetId", e.target.value)} style={{ maxWidth: 320 }} />
      </div>
      <div className="form-group">
        <label htmlFor="meta-crm-token" style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Access token</label>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
          The same dataset's Settings → Conversions API → Generate access token.
          {settings.tokenSet ? ` Leave blank to keep the one in use (${settings.tokenMasked}).` : ""}
        </div>
        <input id="meta-crm-token" className="form-input" type="password" autoComplete="new-password" value={form.token}
          placeholder={settings.tokenSet ? "Leave blank to keep the current token" : "Paste the access token"}
          onChange={(e) => setField("token", e.target.value)} />
      </div>
      <div className="form-group">
        <label htmlFor="meta-crm-test-code" style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Test event code (optional)</label>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
          Events Manager → the dataset → Test events. With it, Test sends ONE test event you can see there — a copy of a
          lead Meta already received as Qualified in the last 47 hours, so Meta counts it once (a test code alone does not
          keep an event out of ads). With no such lead it does not send. The code is never saved.
        </div>
        <input id="meta-crm-test-code" className="form-input" value={form.testEventCode} placeholder="e.g. TEST12345"
          onChange={(e) => setField("testEventCode", e.target.value)} style={{ maxWidth: 240 }} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-secondary touch-target" onClick={runTest} disabled={testing || saving}>
          {testing ? "Testing…" : "Test"}
        </button>
        <button className="btn btn-primary touch-target" onClick={save} disabled={!saveAllowed}>
          {saving ? "Saving…" : "Save"}
        </button>
        <span style={{ fontSize: 12, color: "#94a3b8" }}>
          {edited ? "The values changed after the test — test again to save." : (saveAllowed ? "" : "Save unlocks after a passing Test.")}
        </span>
      </div>

      {message && <div className={`alert alert-${message.type === "error" ? "error" : "success"}`} style={{ marginTop: 12 }}>{message.text}</div>}
      <CheckList result={result} />
    </div>
  );
}
