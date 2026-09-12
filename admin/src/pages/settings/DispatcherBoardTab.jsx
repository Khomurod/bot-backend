import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { KeyField, NumField, Banner } from "./fields";

/**
 * Settings → Dispatcher Board.
 *
 * The Board is the authority on today's assignment — who is in which truck,
 * with which trailer, at what status. Wenze stays the authority on who a person
 * permanently is.
 *
 * The token is write-only: the server returns a masked last-4 and nothing else,
 * and Test proves a candidate BEFORE it is saved. What comes back from Test is
 * counts and histograms, never rows: a settings screen has no business
 * rendering driver names or phone numbers to answer "did it connect".
 */

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TestResult({ result }) {
  if (!result) return null;
  if (!result.connected) {
    return <div className="alert alert-error" style={{ marginTop: 12 }}>{result.message}</div>;
  }
  const fleet = result.fleet || {};
  const status = result.status || {};
  return (
    <div className="ios-glass" style={{ padding: 14, marginTop: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>✅ {result.message}</div>
      <Row label="Board date" value={result.boardDate || "not given"} />
      <Row label="Company drivers" value={fleet.company ?? 0} />
      <Row label="Lease drivers" value={fleet.lease ?? 0} />
      <Row label="Owner operators" value={fleet.owner_operator ?? 0} />
      <Row label="Fleet not recognised" value={fleet.unknown ?? 0} />
      <Row label="Team rows" value={result.teams ?? 0} />
      {result.normalisedLabels > 0 && (
        <Row label="Misspelled labels accepted" value={result.normalisedLabels} />
      )}
      <div style={{ marginTop: 10, fontSize: 12, color: "#94a3b8" }}>
        Statuses: {Object.entries(status).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}
      </div>
      {result.unknownFields?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#f59e0b" }}>
          Columns Wenze does not read yet: {result.unknownFields.join(", ")}
        </div>
      )}
    </div>
  );
}

export default function DispatcherBoardTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState(null);
  const [test, setTest] = useState(null);
  const [form, setForm] = useState({ enabled: false, baseUrl: "", token: "", pollIntervalSeconds: 300 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.getDispatchBoardSettings();
      setSettings(s);
      setForm((f) => ({
        ...f,
        enabled: s.enabled,
        baseUrl: s.baseUrl || "",
        pollIntervalSeconds: s.pollIntervalSeconds ?? 300,
      }));
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const payload = {
        enabled: form.enabled,
        baseUrl: form.baseUrl.trim(),
        pollIntervalSeconds: Number(form.pollIntervalSeconds),
      };
      if (form.token.trim()) payload.token = form.token.trim();
      const s = await api.updateDispatchBoardSettings(payload);
      setSettings(s);
      // The token never lives in this form longer than one submission.
      setForm((f) => ({ ...f, token: "" }));
      setMessage({ type: "success", text: "Saved." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  const runTest = async () => {
    setTesting(true); setTest(null);
    try {
      setTest(await api.testDispatchBoardConnection({
        baseUrl: form.baseUrl.trim() || undefined,
        token: form.token.trim() || undefined,
      }));
    } catch (err) { setTest({ connected: false, message: err.message }); }
    finally { setTesting(false); }
  };

  if (loading) return <div style={{ padding: 20, color: "#94a3b8" }}>Loading…</div>;

  return (
    <div className="ios-glass" style={{ padding: 20 }}>
      <h3 style={{ marginTop: 0 }}>🗂️ Dispatcher Board</h3>
      <p style={{ color: "#94a3b8", fontSize: 13, marginTop: 0 }}>
        The board is the source of truth for <strong>today's assignment</strong> — truck, trailer,
        status, ETA and dispatcher. Wenze remains the source of truth for who a driver is and what
        has happened to them. Nothing is read until this is switched on.
      </p>

      <Banner message={message} />

      <div className="form-group" style={{ marginBottom: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setField("enabled", e.target.checked)}
          />
          Read the board automatically
        </label>
      </div>

      <div className="form-group">
        <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Board web app URL</label>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
          The Apps Script link that ends in <code>/exec</code>.
        </div>
        <input
          className="form-input"
          type="text"
          value={form.baseUrl}
          placeholder="https://script.google.com/macros/s/…/exec"
          onChange={(e) => setField("baseUrl", e.target.value)}
        />
      </div>

      <KeyField
        label="Board access token"
        hint={settings?.tokenSet ? settings.tokenMasked : "not set"}
        value={form.token}
        onChange={(v) => setField("token", v)}
      />

      <NumField
        label="Check the board every"
        value={form.pollIntervalSeconds}
        onChange={(v) => setField("pollIntervalSeconds", v)}
        suffix="seconds (60–3600)"
      />

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn btn-primary touch-target" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-ghost touch-target" onClick={runTest} disabled={testing}>
          {testing ? "Testing…" : "Test connection"}
        </button>
      </div>

      <TestResult result={test} />

      {settings?.lastPollAt && (
        <div className="ios-glass" style={{ padding: 14, marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Last read</div>
          <Row label="When" value={new Date(settings.lastPollAt).toLocaleString()} />
          <Row label="Result" value={settings.lastPollOk ? "ok" : "failed"} />
          {settings.lastPollCount != null && <Row label="Rows" value={settings.lastPollCount} />}
          {settings.lastError && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#f87171" }}>{settings.lastError}</div>
          )}
        </div>
      )}
    </div>
  );
}
