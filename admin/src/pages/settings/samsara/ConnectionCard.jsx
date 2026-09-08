import React, { useState } from "react";
import * as api from "../../../api";
import { KeyField } from "../fields";

/**
 * Samsara connection: enabled, the API key, and a connection test.
 *
 * THE KEY IS WRITE-ONLY. The server returns a masked hint and never the value,
 * so an empty box means "keep the key that is already working" — which is what
 * makes this page safe to open and save without re-entering the credential that
 * is currently deployed.
 *
 * "Test" verifies the box's contents when it has any, and the stored key when
 * it does not, so a replacement can be proven BEFORE Save replaces the working
 * one.
 */
export function ConnectionCard({ settings, form, setField, onSaved }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const runTest = async () => {
    setTesting(true); setResult(null);
    try {
      setResult(await api.testSamsaraConnection(form.apiKey || undefined));
    } catch (err) {
      setResult({ connected: false, message: err.message });
    } finally { setTesting(false); }
  };

  const clearKey = async () => {
    if (!window.confirm(
      "Remove the saved Samsara API key?\n\nThe integration falls back to the SAMSARA_API_KEY "
      + "environment variable. If none is set, Samsara stops working."
    )) return;
    onSaved(await api.updateSamsaraSettings({ clearApiKey: true }));
  };

  const sourceLabel = {
    database: "saved in this panel",
    environment: "from the Render environment variable",
    none: "not configured",
  }[settings.apiKeySource] || settings.apiKeySource;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>🔌 Connection</h3>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setField("enabled", e.target.checked)}
        /> Samsara enabled
      </label>

      <KeyField
        label="Samsara API key"
        hint={settings.apiKeyMasked || "not set"}
        fromEnv={settings.apiKeyFromEnv}
        value={form.apiKey}
        onChange={(v) => setField("apiKey", v)}
      />
      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: -6, marginBottom: 10 }}>
        Currently {sourceLabel}. Leave blank to keep it; enter a new key to replace it
        everywhere, including the Samsara poller.
      </div>

      {settings.apiKeyUnreadable && (
        <div className="alert alert-error" style={{ marginBottom: 10 }}>
          A key is stored but this server cannot decrypt it — the shared secret it was
          saved under has changed. Samsara is running on the environment variable until
          you enter the key again here.
        </div>
      )}
      {!settings.sharedSecretAvailable && (
        <div className="alert alert-error" style={{ marginBottom: 10 }}>
          No shared secret is available on this server, so a key saved here could not be
          stored securely. Set <code>DATABASE_URL</code> (or <code>INTEGRATION_SECRET_KEY</code>)
          before saving a key.
        </div>
      )}

      <div className="form-group">
        <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>API base URL</label>
        <input
          className="form-input"
          value={form.apiBase}
          placeholder="https://api.samsara.com"
          onChange={(e) => setField("apiBase", e.target.value)}
        />
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
        <button className="btn btn-secondary btn-sm" onClick={runTest} disabled={testing}>
          {testing ? "Testing…" : "Test connection"}
        </button>
        {settings.apiKeySource === "database" && (
          <button className="btn btn-ghost btn-sm" style={{ color: "#f87171" }} onClick={clearKey}>
            Remove saved key
          </button>
        )}
      </div>

      {result && (
        <div
          className={`alert alert-${result.connected ? "success" : "error"}`}
          style={{ marginTop: 10 }}
        >
          {result.connected && result.testedSaved ? "Saved key: " : ""}{result.message}
        </div>
      )}
    </div>
  );
}
