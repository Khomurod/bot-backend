import React from "react";

import * as api from "../../../api";

/**
 * Settings → AI → Add Provider: pick it, paste the key, Connect.
 *
 * Everything else — protocol, endpoint, which models exist and which can be
 * asked, whether the key works — is Wenze's job, and the result panel says in
 * plain words what it found. The one provider that asks for a Base URL is the
 * custom one, because it is the one Wenze cannot know anything about.
 *
 * A failed connect is a normal response, not an error banner: "API key is
 * invalid" and "reachable, but no compatible free models" are different
 * problems with different fixes, and the message names which.
 */
export default function AddProviderPanel({ onConnected, onCancel }) {
  const [catalog, setCatalog] = React.useState(null);
  const [picked, setPicked] = React.useState(null);
  const [apiKey, setApiKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);

  React.useEffect(() => {
    api.getAiCatalog().then(setCatalog).catch((err) => {
      setLoadError(err?.detail || err?.message || "Could not load the provider list.");
    });
  }, []);

  const connect = async () => {
    if (!picked) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.connectAiProvider({
        catalogKey: picked.key,
        apiKey: apiKey.trim(),
        ...(picked.needsBaseUrl ? { baseUrl: baseUrl.trim(), label: label.trim() || undefined } : {}),
      });
      setResult(r);
      if (r.ok) {
        setApiKey("");
        onConnected?.(r);
      }
    } catch (err) {
      setResult({ ok: false, message: err?.detail || err?.message || "Could not connect." });
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <div className="alert alert-error">{loadError}</div>;
  if (!catalog) return <div className="loading"><div className="spinner" /> Loading providers…</div>;

  const canConnect = Boolean(picked) && apiKey.trim().length > 0
    && (!picked.needsBaseUrl || /^https:\/\//i.test(baseUrl.trim()));

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Add a provider</strong>
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        )}
      </div>
      <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
        Choose one, paste its API key, and Connect. Wenze works out the endpoint,
        finds the models, checks the key with one call and sets up a fallback order.
      </div>

      <div
        role="listbox" aria-label="Provider"
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, marginTop: 12 }}
      >
        {catalog.map((entry) => {
          const selected = picked?.key === entry.key;
          return (
            <button
              key={entry.key} type="button" role="option" aria-selected={selected}
              className={`btn btn-sm ${selected ? "btn-primary" : "btn-secondary"}`}
              style={{ justifyContent: "flex-start", textAlign: "left", opacity: entry.configured && !selected ? 0.6 : 1 }}
              onClick={() => { setPicked(entry); setResult(null); }}
              title={entry.freeTierNote || ""}
            >
              <span>
                {entry.label}
                {entry.configured && <span style={{ fontSize: 10, marginLeft: 6 }}>(added)</span>}
                {entry.isFree && !entry.configured && (
                  <span className="badge" style={{ marginLeft: 6, fontSize: 10 }}>free tier</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {picked && (
        <div style={{ marginTop: 12 }}>
          {picked.freeTierNote && (
            <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 8 }}>{picked.freeTierNote}</div>
          )}
          <div className="home-time-form-grid">
            {picked.needsBaseUrl && (
              <>
                <div className="form-group">
                  <label htmlFor="add-provider-label">Name</label>
                  <input
                    id="add-provider-label" className="form-input" value={label}
                    placeholder="e.g. Office LLM" onChange={(e) => setLabel(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="add-provider-base-url">API Base URL</label>
                  <input
                    id="add-provider-base-url" className="form-input" value={baseUrl}
                    placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </div>
              </>
            )}
            <div className="form-group" style={{ gridColumn: "1 / -1" }}>
              <label htmlFor="add-provider-key">{picked.label} API key</label>
              <input
                id="add-provider-key" className="form-input" type="password" value={apiKey}
                placeholder={picked.keyPrefix ? `${picked.keyPrefix}…` : "Paste the key"}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canConnect && !busy) connect(); }}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={!canConnect || busy} onClick={connect}>
              {busy ? "Connecting…" : "Connect"}
            </button>
            {picked.docsUrl && (
              <a href={picked.docsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                Where to get a {picked.label} key
              </a>
            )}
          </div>
        </div>
      )}

      {result && (
        <div
          role="status"
          className={`alert alert-${result.ok ? "success" : "warning"}`}
          style={{ marginTop: 12, whiteSpace: "pre-line", fontSize: 13 }}
        >
          {result.message}
          {result.ok && result.report?.selected?.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#94a3b8" }}>
              Fallback order: {result.report.selected.join(" → ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
