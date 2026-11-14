import React from "react";

import * as api from "../../../api";

/**
 * AI Tasks (named AI Responsibilities until November 2026) — what Wenze is
 * allowed to use AI for, in words.
 *
 * COMPACT SINCE NOVEMBER 2026. Each task is one row: its name, what it may do
 * (the two badges), one line of what it decides, and its switches. Why it may
 * change something, the automatic change's rule and what happens with AI off
 * are behind "How it works" — read once, not scrolled past seventeen times.
 * The automatic-change switch itself stays in view.
 *
 * The old "What AI is used for" table listed capability keys and rendered
 * nothing at all in production, because no row was ever written. Worse, it
 * could not answer the question that decides how much care a switch deserves:
 * WHICH of these can change a driver's record on its own?
 *
 * So each responsibility says what it decides, whether it can change stored
 * information, and what happens with no AI at all — and the ones that can
 * change something carry a second, separate switch for the automatic change.
 * "Analysis on, automatic changes off" is a sensible way to run a fleet.
 */
export default function ResponsibilitiesCard({ flash }) {
  const [groups, setGroups] = React.useState([]);
  const [automationError, setAutomationError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const data = await api.getAiResponsibilities();
      setGroups(data.groups);
      setAutomationError(data.automationError);
      setError(null);
    } catch (err) {
      setError(err.message || "Could not load the AI responsibilities.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  async function toggle(capability, aiEnabled) {
    setBusy(capability.key);
    try {
      await api.updateAiCapability(capability.key, { aiEnabled });
      flash?.("success", `${capability.label}: AI analysis ${aiEnabled ? "on" : "off"}.`);
      await load();
    } catch (err) {
      flash?.("error", err.message || "Could not save that.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * The second switch: may Wenze make the change by itself when it IS confident?
   *
   * It writes the SAME `operational_check_settings` row that Operations →
   * Needs attention → Automation writes — one owner for the setting, two places
   * that can reach it — so the two screens can never disagree about what the
   * software is allowed to do.
   */
  async function toggleAutomation(capability, enabled) {
    const key = `${capability.key}:auto`;
    setBusy(key);
    try {
      await api.updateOperationsCheck(capability.automation.checkKey, {
        autoApplyEnabled: enabled,
        maxAutoPerRun: capability.automation.maxPerRun ?? null,
      });
      flash?.("success", `${capability.label}: automatic changes ${enabled ? "on" : "off"}.`);
      await load();
    } catch (err) {
      flash?.("error", err.message || "Could not save that.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="card"><h3>AI Tasks</h3><p>Loading…</p></div>;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>AI Tasks</h3>
      <p className="muted">
        Every decision Wenze can use AI for. Switching one off does not break the feature —
        "How it works" on each one says what Wenze does instead.
      </p>
      {error && <p className="error">{error}</p>}
      {automationError && (
        <p className="error">
          The automatic-change settings could not be read, so those switches are shown as unknown
          rather than off. Wenze may still be applying corrections. ({automationError})
        </p>
      )}

      {groups.map((group) => (
        <div key={group.group} style={{ marginTop: 18 }}>
          <h4 style={{ margin: "0 0 8px" }}>{group.group}</h4>
          {group.capabilities.map((cap) => (
            <div
              key={cap.key}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 12px",
                marginBottom: 6,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{cap.label}</strong>
                  {cap.changesState && (
                    <span
                      title={cap.stateNote || ""}
                      style={{
                        marginLeft: 8, fontSize: 11, padding: "1px 6px", borderRadius: 999,
                        background: "var(--warning-soft)", color: "var(--warning)",
                      }}
                    >
                      can change information
                    </span>
                  )}
                  {cap.sendsRawText && (
                    <span
                      title="The prompt includes message text from a driver group."
                      style={{
                        marginLeft: 6, fontSize: 11, padding: "1px 6px", borderRadius: 999,
                        background: "var(--neutral-soft)",
                      }}
                    >
                      sends message text
                    </span>
                  )}
                  <div className="muted" style={{ marginTop: 2, fontSize: 13 }}>{cap.what}</div>
                  {/* A task kept to providers of its own (the CDL reading): who reads it. */}
                  {cap.providerChoice && Array.isArray(cap.providerOrder) && (
                    <div style={{ marginTop: 2, fontSize: 12 }}>
                      {cap.providerOrder.length
                        ? <span className="muted">Asked only of the providers chosen for it ({cap.providerOrder.join(" → ")}). </span>
                        : <span style={{ color: "var(--danger)" }}>No provider chosen — nothing is read. </span>}
                      <a href="#settings/ai">Choose them in AI Providers</a>
                    </div>
                  )}
                </div>
                <label style={{ whiteSpace: "nowrap" }}>
                  <input
                    type="checkbox"
                    checked={cap.aiEnabled}
                    disabled={busy === cap.key}
                    onChange={(e) => toggle(cap, e.target.checked)}
                  />{" "}
                  AI analysis
                </label>
              </div>

              {/* The second switch stays in view: it is the one that lets Wenze
                  change a record by itself, and a person must see it is there. */}
              {cap.automation && (
                <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 13, flexWrap: "wrap" }}>
                  <input
                    type="checkbox"
                    checked={cap.automation.enabled === true}
                    disabled={busy === `${cap.key}:auto` || cap.automation.known === false}
                    onChange={(e) => toggleAutomation(cap, e.target.checked)}
                  />
                  <strong>Make the change automatically when Wenze is confident</strong>
                  {cap.automation.known === false && (
                    <span className="muted">— setting unknown, could not be read</span>
                  )}
                  {cap.automation.maxPerRun != null && (
                    <span className="muted">(at most {cap.automation.maxPerRun} a run)</span>
                  )}
                </label>
              )}

              {/* What it may change, the automatic change's rule and the
                  fallback: the reasons behind the switches, read once. */}
              {(cap.stateNote || cap.automation || cap.fallback) && (
                <details style={{ marginTop: 4, fontSize: 12 }}>
                  <summary className="muted" style={{ cursor: "pointer" }}>How it works</summary>
                  {cap.stateNote && (
                    <div className="muted" style={{ marginTop: 4 }}><em>{cap.stateNote}</em></div>
                  )}
                  {cap.automation && (
                    <div className="muted" style={{ marginTop: 4 }}>
                      {cap.mediumNote || "Anything less than confident goes to Needs Attention instead."}{" "}
                      The same automatic-change switch is in{" "}
                      <a href="#operations/checks">Needs Attention → Automation</a>.
                    </div>
                  )}
                  {cap.fallback && (
                    <div className="muted" style={{ marginTop: 4 }}>
                      <strong>With AI off:</strong> {cap.fallback}
                    </div>
                  )}
                </details>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
