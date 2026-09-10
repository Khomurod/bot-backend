import React from "react";

import * as api from "../../../api";

/**
 * The terms watcher: what the providers' own pages say, and when it changed.
 *
 * Two things this card is careful about.
 *
 * The Telegram destination is validated server-side before it is stored, and a
 * rejection comes back with the CORRECTED id in `suggestion` — so a dropped
 * minus sign is offered back as a one-click fix rather than as an error
 * message. That failure (`5052301861` instead of `-5052301861`) silently
 * discarded 101 home-time alerts for months, and this feature exists to tell
 * people things.
 *
 * Automatic suspension is a separate switch from the watcher itself, and it
 * ships off. An operator who wants to be told but never overruled is a
 * completely reasonable operator.
 */
/** Where a page's address came from. A person can tell at a glance what Wenze did for them. */
const ORIGIN_LABEL = {
  catalog: "found automatically",
  rediscovered: "found again",
  manual: "added by hand",
};

const SEVERITY_STYLE = {
  info: { color: "#94a3b8", mark: "ℹ️" },
  warning: { color: "#f59e0b", mark: "⚠️" },
  serious: { color: "#f87171", mark: "🚨" },
};

function Finding({ finding, onAcknowledge }) {
  const [open, setOpen] = React.useState(false);
  const style = SEVERITY_STYLE[finding.severity] || SEVERITY_STYLE.info;

  return (
    <div style={{ borderTop: "1px solid rgba(148,163,184,0.15)", padding: "8px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <span style={{ color: style.color }}>{style.mark}</span>{" "}
          <strong>{finding.providerKey}</strong>{" "}
          <span style={{ color: "#94a3b8", fontSize: 11 }}>{finding.category}</span>
          <div style={{ fontSize: 12, marginTop: 2 }}>{finding.summary}</div>
          {finding.suspendedProvider && (
            <div style={{ color: "#f87171", fontSize: 11, marginTop: 2 }}>
              Paused by rule <code>{finding.suspensionRule}</code> — clear the cooldown above
              once you have reviewed it.
            </div>
          )}
          {!finding.aiAssisted && (
            <div style={{ color: "#94a3b8", fontSize: 11, fontStyle: "italic", marginTop: 2 }}>
              No AI was available to summarise this; it is reported from the raw difference.
            </div>
          )}
        </div>
        <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Their words"}
          </button>
          {!finding.acknowledgedAt && (
            <button
              type="button" className="btn btn-ghost btn-sm"
              onClick={() => onAcknowledge(finding.id)}
            >
              Acknowledge
            </button>
          )}
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 6 }}>
          {finding.whatChanged && (
            <div style={{ fontSize: 12 }}><b>What changed:</b> {finding.whatChanged}</div>
          )}
          {finding.whyItMatters && (
            <div style={{ fontSize: 12 }}><b>Why it matters:</b> {finding.whyItMatters}</div>
          )}
          <pre style={{
            fontSize: 11, background: "rgba(148,163,184,0.08)", padding: 8,
            borderRadius: 6, whiteSpace: "pre-wrap", marginTop: 6, maxHeight: 260, overflow: "auto",
          }}>
            {finding.quotedPassage}
          </pre>
          <a href={finding.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
            Read the official page
          </a>
        </div>
      )}
    </div>
  );
}

export default function PolicyWatcherCard({ providers, flash }) {
  const [data, setData] = React.useState(null);
  const [chatId, setChatId] = React.useState("");
  const [suggestion, setSuggestion] = React.useState(null);
  const [newSource, setNewSource] = React.useState({ providerKey: "", url: "", kind: "terms" });
  const [running, setRunning] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const next = await api.getAiPolicyWatcher();
      setData(next);
      setChatId(next.settings.notifyChatId || "");
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not load the terms watcher.");
    }
  }, [flash]);

  React.useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    setSuggestion(null);
    try {
      await api.updateAiPolicyWatcher(patch);
      flash("success", "Saved.");
      load();
    } catch (err) {
      // A rejected chat id comes back with the corrected value — offer it
      // rather than making somebody work out the minus sign themselves.
      if (err?.suggestion) setSuggestion(err.suggestion);
      flash("error", err?.detail || err?.message || "Could not save.");
    }
  };

  /**
   * One click turns "I think the destination works" into a message on a phone.
   * Sends to what is typed, so a candidate can be proven before it is saved.
   */
  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testAiPolicyNotification({ chatId: chatId || undefined });
      setTestResult(r.ok
        ? { ok: true, text: `Test message sent to ${r.chatId}.` }
        : { ok: false, text: `Could not send: ${r.error}` });
    } catch (err) {
      setTestResult({ ok: false, text: err?.detail || err?.message || "Could not send." });
    } finally {
      setTesting(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const summary = await api.runAiPolicyCheck();
      flash("success", summary?.skipped
        ? summary.reason
        : `Checked ${summary.sources} page(s): ${summary.findings} finding(s), `
          + `${summary.notModified + summary.unchanged} unchanged, ${summary.errors} error(s).`);
      load();
    } catch (err) {
      flash("error", err?.detail || err?.message || "The check failed.");
    } finally {
      setRunning(false);
    }
  };

  if (!data) return null;
  const { settings, sources, findings, alerts } = data;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <strong>📜 Provider terms watcher</strong>
      <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
        Checks each enabled provider's own pages twice a week. A page that only
        re-rendered costs nothing and reaches no model — only a change that a
        difference actually proves is real gets read and reported.
      </div>

      <div className="home-time-form-grid" style={{ marginTop: 12 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox" checked={settings.enabled}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          Watch the terms
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox" checked={settings.autoSuspendEnabled}
            onChange={(e) => save({ autoSuspendEnabled: e.target.checked })}
          />
          Let a matched rule pause a provider
        </label>
        <div className="form-group">
          <label>Tell this Telegram chat</label>
          <input
            className="form-input" value={chatId}
            placeholder="-1002997837889"
            onChange={(e) => setChatId(e.target.value)}
            onBlur={() => chatId !== (settings.notifyChatId || "") && save({ notifyChatId: chatId })}
          />
          {suggestion && (
            <button
              type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 4 }}
              onClick={() => { setChatId(String(suggestion)); save({ notifyChatId: String(suggestion) }); }}
            >
              Use {suggestion} instead
            </button>
          )}
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 4 }}>
            A group, or a person the bot can message.
          </div>
          <button
            type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 6 }}
            disabled={testing || !chatId} onClick={sendTest}
          >
            {testing ? "Sending…" : "Send a test message"}
          </button>
          {testResult && (
            <div role="status" style={{ fontSize: 12, marginTop: 4, color: testResult.ok ? "#22c55e" : "#f59e0b" }}>
              {testResult.text}
            </div>
          )}
        </div>
        <div className="form-group">
          <label>Only tell me about</label>
          <select
            className="form-select" value={settings.notifyMinSeverity}
            onChange={(e) => save({ notifyMinSeverity: e.target.value })}
          >
            <option value="info">everything</option>
            <option value="warning">warnings and worse</option>
            <option value="serious">only serious changes</option>
          </select>
        </div>
      </div>

      {alerts?.exhausted?.count > 0 && (
        <div className="alert alert-error" style={{ marginTop: 8, fontSize: 12 }}>
          {alerts.exhausted.count} alert(s) could not be delivered and have given up retrying.
          The chat id above is the usual cause.
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: 13 }}>Pages being watched</strong>
          <button type="button" className="btn btn-ghost btn-sm" disabled={running} onClick={runNow}>
            {running ? "Checking…" : "Check now"}
          </button>
        </div>
        {sources.length === 0 ? (
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>
            No pages yet. For a provider Wenze knows, its official pages are added
            automatically the next time the watcher runs — or press Check now.
          </div>
        ) : (
          <ul style={{ fontSize: 12, paddingLeft: 18, marginTop: 6 }}>
            {sources.map((s) => (
              <li key={s.id} style={{ marginBottom: 3, opacity: s.enabled ? 1 : 0.6 }}>
                <code>{s.providerKey}</code> · {s.kind} ·{" "}
                <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>{" "}
                <span className="badge badge-muted" style={{ fontSize: 10 }}>
                  {ORIGIN_LABEL[s.sourceOrigin] || s.sourceOrigin}
                </span>
                {s.movedFrom && (
                  <span style={{ color: "#94a3b8" }}> — moved from {s.movedFrom}</span>
                )}
                {s.lostReportedAt && (
                  <span style={{ color: "#f87171" }}> — could not be found; you have been told</span>
                )}
                {s.lastError && !s.lostReportedAt && <span style={{ color: "#f59e0b" }}> — {s.lastError}</span>}
                <button
                  type="button" className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    await api.deleteAiPolicySource(s.id);
                    load();
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <details className="collapse-panel" style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 12 }}>Add a page by hand</summary>
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 4 }}>
            Only needed for a custom provider, or a page Wenze does not know about.
            Pages found automatically are kept current — followed when they move,
            searched for when they disappear.
          </div>
        <div className="home-time-form-grid" style={{ marginTop: 8 }}>
          <div className="form-group">
            <label htmlFor="policy-source-provider">Provider</label>
            <select
              id="policy-source-provider"
              className="form-select" value={newSource.providerKey}
              onChange={(e) => setNewSource((p) => ({ ...p, providerKey: e.target.value }))}
            >
              <option value="">Choose…</option>
              {(providers || []).map((p) => (
                <option key={p.providerKey} value={p.providerKey}>{p.label || p.providerKey}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="policy-source-kind">Page kind</label>
            <select
              id="policy-source-kind"
              className="form-select" value={newSource.kind}
              onChange={(e) => setNewSource((p) => ({ ...p, kind: e.target.value }))}
            >
              <option value="terms">Terms of service</option>
              <option value="privacy">Privacy policy</option>
              <option value="acceptable_use">Acceptable use</option>
              <option value="pricing">Pricing / free tier</option>
              <option value="model_policy">Model policy</option>
            </select>
          </div>
          <div className="form-group" style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="policy-source-url">URL (https)</label>
            <input
              id="policy-source-url"
              className="form-input" value={newSource.url}
              placeholder="https://provider.example/terms"
              onChange={(e) => setNewSource((p) => ({ ...p, url: e.target.value }))}
            />
          </div>
        </div>
        <button
          type="button" className="btn btn-secondary btn-sm"
          disabled={!newSource.providerKey || !newSource.url}
          onClick={async () => {
            try {
              await api.addAiPolicySource(newSource);
              setNewSource({ providerKey: "", url: "", kind: "terms" });
              load();
            } catch (err) {
              flash("error", err?.detail || err?.message || "Could not add it.");
            }
          }}
        >
          Watch this page
        </button>
        </details>
      </div>

      <div style={{ marginTop: 14 }}>
        <strong style={{ fontSize: 13 }}>What has changed</strong>
        {findings.length === 0 ? (
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
            Nothing yet. The first look at a page is recorded as a baseline, not
            reported as a change.
          </div>
        ) : findings.map((f) => (
          <Finding
            key={f.id}
            finding={f}
            onAcknowledge={async (id) => { await api.acknowledgeAiPolicyFinding(id); load(); }}
          />
        ))}
      </div>
    </div>
  );
}
