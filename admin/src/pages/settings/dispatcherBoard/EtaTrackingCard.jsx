import React from "react";
import { timeAgo } from "../../../utils/formatTime";
import { ToggleSwitch } from "./ToggleSwitch";
import { formatIntervalText, normalizeEtaEnabled } from "./helpers";

/**
 * Automatic ETA updates: which groups get them, and how often.
 *
 * WHY THIS IS ON THE DISPATCHER BOARD TAB. It is the only place per-group ETA
 * delivery and the global intervals can be configured — this screen IS the
 * setting. The Dispatch Center it used to share a page with is gone
 * (`docs/architecture/retired-dispatch-center.md`); deleting this with it would
 * have turned a UI removal into a data change, leaving these rows editable only
 * by hand in the database.
 *
 * Each row shows BOTH switches so the driver/test choice is visible rather than
 * hidden in a mode dropdown — they are mutually exclusive, and seeing which one
 * is lit is how an admin confirms a group is not messaging real drivers during
 * a test.
 *
 * The bulk toggles and the interval save are deliberately loud about what they
 * touched (how many groups, which target, how many immediate sends landed),
 * because they act on every active driver group at once.
 *
 * THE PER-GROUP DIAGNOSTICS EXPANDER IS GONE. It called a Dispatch Center
 * endpoint that reached Telegram, Samsara and the ETA router on every click to
 * render pinned-message previews, ingested loads, coordinates and provider
 * status — a debugging console wearing a settings page's clothes. What it was
 * really answering ("is this working?") is answered properly by Operations →
 * System & AI Health, from recorded runs rather than a live fan-out.
 *
 * Originally split out of admin/src/pages/DispatchPage.jsx.
 */
export function EtaTrackingCard(p) {
  const {
    testingGroups, dispatchEtaTestGroupId, testingLoading,
    testingSavingGroupId, testingBulkSavingMode,
    globalDriverIntervalMin, setGlobalDriverIntervalMin,
    globalTestIntervalMin, setGlobalTestIntervalMin, savingGlobalIntervals,
    loadTestingGroups, handleTestingToggle,
    handleTestingToggleAll, handleSaveGlobalIntervals,
  } = p;

  return (

  <div className="card">
    <div style={{ marginBottom: "16px" }}>
      <h3 style={{ marginBottom: "6px" }}>ETA Update Configuration</h3>
      <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
        Configure automatic ETA updates for each driver group. When enabled, drivers receive periodic position and arrival time updates.
      </p>
    </div>

    <div
      style={{
        marginBottom: "18px",
        padding: "14px 16px",
        borderRadius: "12px",
        border: "1px solid var(--border)",
        background: "var(--bg-primary)",
        display: "grid",
        gap: "12px",
      }}
    >
      <div style={{ fontWeight: 600 }}>Update Frequency</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "flex-end" }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: "200px" }}>
          <label>Driver updates every (minutes)</label>
          <input
            type="number"
            className="form-input"
            min={1}
            max={1440}
            value={globalDriverIntervalMin}
            onChange={(e) => setGlobalDriverIntervalMin(Number(e.target.value))}
            disabled={testingLoading || savingGlobalIntervals}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0, minWidth: "200px" }}>
          <label>Test updates every (minutes)</label>
          <input
            type="number"
            className="form-input"
            min={1}
            max={1440}
            value={globalTestIntervalMin}
            onChange={(e) => setGlobalTestIntervalMin(Number(e.target.value))}
            disabled={testingLoading || savingGlobalIntervals}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={handleSaveGlobalIntervals}
          disabled={testingLoading || savingGlobalIntervals || testingBulkSavingMode !== null}
        >
          {savingGlobalIntervals ? "Saving..." : "Save Frequency"}
        </button>
      </div>
      <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
        Changes apply to all groups immediately. Driver-mode groups use the first value, test-mode groups use the second.
      </div>
    </div>

    <div style={{ marginBottom: "14px" }}>
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={loadTestingGroups}
          disabled={testingLoading || testingBulkSavingMode !== null}
        >
          {testingLoading ? "Refreshing..." : "🔄 Refresh"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => handleTestingToggleAll("driver", true)}
          disabled={testingBulkSavingMode !== null}
        >
          {testingBulkSavingMode === "driver" ? "Applying..." : "🟢 Enable All (Driver)"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => handleTestingToggleAll("test", true)}
          disabled={testingBulkSavingMode !== null || !dispatchEtaTestGroupId}
          title={dispatchEtaTestGroupId ? `Test group: ${dispatchEtaTestGroupId}` : "DISPATCH_ETA_TEST_GROUP_ID not configured"}
        >
          {testingBulkSavingMode === "test" ? "Applying..." : "🟡 Enable All (Test)"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => handleTestingToggleAll("driver", false)}
          disabled={testingBulkSavingMode !== null}
        >
          🔴 Disable All
        </button>
      </div>
    </div>

    {testingLoading ? (
      <div className="loading" style={{ padding: "16px 0", justifyContent: "flex-start" }}>
        <div className="spinner"></div>
        Loading active driver groups...
      </div>
    ) : (
      <div style={{ display: "grid", gap: "10px" }}>
        {testingGroups.length === 0 && (
          <div style={{ color: "var(--text-secondary)" }}>No active driver groups found.</div>
        )}

        {testingGroups.map((row) => {
          const saving = testingSavingGroupId === row.group_id;
          const driverEnabled = normalizeEtaEnabled(row.eta_enabled_driver ?? (row.eta_enabled && row.eta_target_mode !== "test"));
          const testEnabled = normalizeEtaEnabled(row.eta_enabled_test ?? (row.eta_enabled && row.eta_target_mode === "test"));
          return (
            <div
              key={row.group_id}
              style={{
                border: "1px solid var(--border)",
                borderRadius: "12px",
                padding: "12px 14px",
                display: "grid",
                gap: "8px",
                background: "var(--bg-secondary)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{row.group_name}</div>
                  <details style={{fontSize: 13, color: 'var(--text-secondary)'}}><summary style={{cursor:'pointer',fontSize:12}}>Technical ID</summary>{row.telegram_group_id}</details>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <ToggleSwitch
                    label="Driver group"
                    checked={driverEnabled}
                    saving={saving}
                    disabled={saving}
                    onToggle={() => handleTestingToggle(row, "driver", !driverEnabled)}
                    ariaLabel={`Toggle driver-group ETA updates for ${row.group_name}`}
                  />
                  <ToggleSwitch
                    label="Test group"
                    checked={testEnabled}
                    saving={saving}
                    disabled={saving || !dispatchEtaTestGroupId}
                    onToggle={() => handleTestingToggle(row, "test", !testEnabled)}
                    title={dispatchEtaTestGroupId ? `Test group: ${dispatchEtaTestGroupId}` : "DISPATCH_ETA_TEST_GROUP_ID not configured"}
                    ariaLabel={`Toggle test-group ETA updates for ${row.group_name}`}
                  />
                </div>
              </div>

              <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", color: "var(--text-secondary)", fontSize: "13px" }}>
                <span>Interval: {formatIntervalText(row.eta_interval_minutes)}</span>
                <span>Status: <span className={`status-pill status-pill--${(row.eta_last_status === "ok" || row.eta_last_status === "success") ? "success" : (row.eta_last_status === "error" || row.eta_last_status === "failed") ? "danger" : (row.eta_last_status === "running" || row.eta_last_status === "sending") ? "info" : "neutral"}`}>{row.eta_last_status || "idle"}</span></span>
                <span>Next run: {row.eta_next_run_at ? new Date(row.eta_next_run_at).toLocaleString() : "—"}</span>
              </div>

              {row.eta_last_error && (
                <div style={{ color: "var(--danger)", fontSize: "13px" }}>
                  Last error: {row.eta_last_error}
                </div>
              )}

            </div>
          );
        })}
      </div>
    )}
  </div>
  );
}
