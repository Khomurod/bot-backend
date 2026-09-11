import React from "react";

import * as api from "../../api";
import ProviderCard from "./ai/ProviderCard";
import AddProviderPanel from "./ai/AddProviderPanel";
import PolicyWatcherCard from "./ai/PolicyWatcherCard";
import ResponsibilitiesCard from "./ai/ResponsibilitiesCard";

/**
 * A capability key as a person would say it. The keys are code identifiers, and
 * "home_time_intent" in a failure list tells an operator nothing about which
 * feature stopped working.
 */
function capabilityLabel(key) {
  if (!key) return "Unnamed";
  return String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}


/**
 * Admin → Settings → AI.
 *
 * The tab is arranged around one idea an operator has to be able to trust:
 * **AI is an accelerator here, never a dependency.** Turning the master switch
 * off is a supported, tested mode — twelve features fall back to deterministic
 * logic and the application keeps working — so the switch says so in words
 * rather than looking like a kill switch nobody dares touch.
 *
 * Health is split by failure CLASS rather than shown as one success rate,
 * because "the free tier is spent" and "the key is dead" need completely
 * different responses from a person and averaging them into a percentage hides
 * which is happening.
 */
function HealthRow({ row }) {
  return (
    <tr style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
      <td style={{ padding: "6px 8px" }}><code>{row.providerKey}</code></td>
      <td style={{ padding: "6px 8px" }}>{row.successPct == null ? "—" : `${row.successPct}%`}</td>
      <td style={{ padding: "6px 8px" }}>{row.avgLatencyMs == null ? "—" : `${row.avgLatencyMs}ms`}</td>
      <td style={{ padding: "6px 8px", color: row.quota ? "#f59e0b" : "#94a3b8" }}>{row.quota}</td>
      <td style={{ padding: "6px 8px", color: row.credential ? "#f87171" : "#94a3b8" }}>
        {row.credential}
      </td>
      <td style={{ padding: "6px 8px", color: "#94a3b8" }}>{row.transient}</td>
    </tr>
  );
}

export default function AiTab() {
  const [data, setData] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [adding, setAdding] = React.useState(false);

  const flash = React.useCallback((type, text) => setStatus({ type, text }), []);

  const load = React.useCallback(async () => {
    try {
      setData(await api.getAiSettings());
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not load AI settings.");
    }
  }, [flash]);

  React.useEffect(() => { load(); }, [load]);

  const saveSettings = async (patch) => {
    try {
      await api.updateAiSettings(patch);
      flash("success", "Saved.");
      load();
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not save.");
    }
  };

  if (!data) {
    return <div className="loading"><div className="spinner" /> Loading AI settings…</div>;
  }
  const {
    settings, providers, health, recentFailures, modelEvents = [],
  } = data;

  return (
    <div>
      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 12 }}>{status.text}</div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>🤖 How AI is used</strong>
        <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
          AI accelerates work here; it never decides anything on its own. With this
          switched off, every feature falls back to its deterministic logic and the
          application keeps working — that is a supported mode, not an outage.
        </div>

        <div className="home-time-form-grid" style={{ marginTop: 12 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input
              type="checkbox" checked={settings.enabled}
              onChange={(e) => saveSettings({ enabled: e.target.checked })}
            />
            Use AI
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input
              type="checkbox" checked={settings.freeOnlyMode}
              onChange={(e) => saveSettings({ freeOnlyMode: e.target.checked })}
            />
            Free tiers only (a guarantee, not a preference)
          </label>
          <div className="form-group">
            <label>When several providers are available</label>
            <select
              className="form-select" value={settings.routingMode}
              onChange={(e) => saveSettings({ routingMode: e.target.value })}
            >
              <option value="priority">Always try them in priority order</option>
              <option value="round_robin">Rotate, so one allowance is not always burned first</option>
            </select>
          </div>
          <div className="form-group">
            <label>Give up on a single call after (ms)</label>
            <input
              className="form-input" type="number" min={5000} max={300000}
              defaultValue={settings.requestTimeoutMs}
              onBlur={(e) => saveSettings({ requestTimeoutMs: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong>Providers</strong>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(!adding)}>
          {adding ? "Cancel" : "Add a provider"}
        </button>
      </div>

      {adding && (
        <AddProviderPanel
          onCancel={() => setAdding(false)}
          onConnected={(r) => { flash("success", `${r.label} connected.`); load(); }}
        />
      )}

      {providers.length === 0 ? (
        <div className="empty-state">
          <div className="icon">🔌</div>
          <h3>No provider is configured here yet</h3>
          <p>
            AI still works: with no rows, the existing GROQ_API_KEY and
            GEMINI_API_KEY environment variables are used exactly as before.
            Adding a provider here is how you take over from them.
          </p>
        </div>
      ) : providers.map((p) => (
        <ProviderCard key={p.providerKey} provider={p} onSaved={load} flash={flash} />
      ))}

      <div className="card" style={{ marginTop: 16 }}>
        <strong>Health, last 24 hours</strong>
        <div style={{ color: "#94a3b8", fontSize: 12 }}>
          Split by what went wrong: a spent allowance and a dead key need
          different answers from you, and one percentage would hide which it is.
        </div>
        {health.length === 0 ? (
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 8 }}>
            No calls recorded yet.
          </div>
        ) : (
          <div className="table-container" style={{ marginTop: 8 }}>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <tbody>
                <tr style={{ color: "#94a3b8" }}>
                  <td style={{ padding: "4px 8px" }}>Provider</td>
                  <td style={{ padding: "4px 8px" }}>Answered</td>
                  <td style={{ padding: "4px 8px" }}>Typical</td>
                  <td style={{ padding: "4px 8px" }}>Out of quota</td>
                  <td style={{ padding: "4px 8px" }}>Key rejected</td>
                  <td style={{ padding: "4px 8px" }}>Busy</td>
                </tr>
                {health.map((row) => <HealthRow key={row.providerKey} row={row} />)}
              </tbody>
            </table>
          </div>
        )}

        {recentFailures.length > 0 && (
          <details className="collapse-panel" style={{ marginTop: 10 }}>
            <summary>Recent failures ({recentFailures.length})</summary>
            <ul style={{ fontSize: 11, paddingLeft: 18, marginTop: 6 }}>
              {recentFailures.map((f, i) => (
                <li key={`${f.createdAt}-${i}`} style={{ marginBottom: 3 }}>
                  {/* What Wenze was trying to DECIDE comes first: a failure is
                      only actionable once you know which feature it belongs to. */}
                  <strong>{capabilityLabel(f.capabilityKey)}</strong> —{" "}
                  <code>{f.providerKey}</code>/{f.model} — {f.failureKind}: {f.errorMessage}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {modelEvents.length > 0 && (
        <details className="collapse-panel card" style={{ marginTop: 16 }}>
          <summary>
            <strong>Model changes</strong>{" "}
            <span style={{ color: "#94a3b8", fontSize: 12 }}>
              — what Wenze added, retired or replaced, and why
            </span>
          </summary>
          <ul style={{ fontSize: 12, paddingLeft: 18, marginTop: 8 }}>
            {modelEvents.map((e) => (
              <li key={e.id} style={{ marginBottom: 3 }}>
                <code>{e.providerKey}</code> {e.event}
                {e.model && <> <code>{e.model}</code></>}
                {e.detail?.replacement && <> → <code>{e.detail.replacement}</code></>}
                {e.detail?.chain && <> ({e.detail.chain.join(" → ")})</>}
                <span style={{ color: "#94a3b8" }}> · {e.initiator}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <ResponsibilitiesCard flash={flash} />

      <PolicyWatcherCard providers={providers} flash={flash} />

    </div>
  );
}
