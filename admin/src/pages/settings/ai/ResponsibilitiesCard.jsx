import React from "react";

import * as api from "../../../api";

/**
 * AI Responsibilities — what Wenze is allowed to use AI for, in words.
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
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      setGroups(await api.getAiResponsibilities());
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
      flash?.(`${capability.label}: AI analysis ${aiEnabled ? "on" : "off"}.`);
      await load();
    } catch (err) {
      flash?.(err.message || "Could not save that.", true);
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
      flash?.(`${capability.label}: automatic changes ${enabled ? "on" : "off"}.`);
      await load();
    } catch (err) {
      flash?.(err.message || "Could not save that.", true);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="card"><h3>AI Responsibilities</h3><p>Loading…</p></div>;

  return (
    <div className="card">
      <h3>🧠 AI Responsibilities</h3>
      <p className="muted">
        Every decision Wenze can use AI for. Switching one off does not break the feature —
        each one says below what Wenze does instead.
      </p>
      {error && <p className="error">{error}</p>}

      {groups.map((group) => (
        <div key={group.group} style={{ marginTop: 18 }}>
          <h4 style={{ margin: "0 0 8px" }}>{group.group}</h4>
          {group.capabilities.map((cap) => (
            <div
              key={cap.key}
              style={{
                border: "1px solid rgba(148,163,184,0.25)",
                borderRadius: 8,
                padding: "10px 12px",
                marginBottom: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div>
                  <strong>{cap.label}</strong>
                  {cap.changesState && (
                    <span
                      title={cap.stateNote || ""}
                      style={{
                        marginLeft: 8, fontSize: 11, padding: "1px 6px", borderRadius: 999,
                        background: "rgba(234,179,8,0.18)", color: "#a16207",
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
                        background: "rgba(148,163,184,0.18)",
                      }}
                    >
                      sends message text
                    </span>
                  )}
                  <div className="muted" style={{ marginTop: 4 }}>{cap.what}</div>
                  {cap.stateNote && (
                    <div className="muted" style={{ marginTop: 4 }}><em>{cap.stateNote}</em></div>
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

              {cap.automation && (
                <div
                  style={{
                    marginTop: 8, paddingTop: 8, borderTop: "1px dashed rgba(148,163,184,0.25)",
                    fontSize: 13,
                  }}
                >
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={cap.automation.enabled}
                      disabled={busy === `${cap.key}:auto`}
                      onChange={(e) => toggleAutomation(cap, e.target.checked)}
                    />
                    <strong>Make the change automatically when Wenze is confident</strong>
                    {cap.automation.maxPerRun != null && (
                      <span className="muted">(at most {cap.automation.maxPerRun} a run)</span>
                    )}
                  </label>
                  <div className="muted" style={{ marginTop: 4 }}>
                    {cap.mediumNote || "Anything less than confident goes to Needs Attention instead."}{" "}
                    The same switch is in Operations → Needs attention → Automation.
                  </div>
                </div>
              )}

              {cap.fallback && (
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                  <strong>With AI off:</strong> {cap.fallback}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
