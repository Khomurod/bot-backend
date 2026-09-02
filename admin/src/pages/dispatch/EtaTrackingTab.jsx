import React from "react";
import { ToggleSwitch } from "./ToggleSwitch";
import { formatIntervalText, normalizeEtaEnabled, formatOptionalDateTime } from "./helpers";

/**
 * ETA Tracking: per-group driver/test toggles, the global intervals, and the
 * expandable per-group diagnostics.
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
 * Split out of admin/src/pages/DispatchPage.jsx.
 */
export function EtaTrackingTab(p) {
  const {
    testingGroups, dispatchEtaTestGroupId, testingLoading,
    testingSavingGroupId, testingBulkSavingMode,
    expandedTestingGroupId, testingDetailsByGroupId, testingDetailsLoadingGroupId,
    globalDriverIntervalMin, setGlobalDriverIntervalMin,
    globalTestIntervalMin, setGlobalTestIntervalMin, savingGlobalIntervals,
    loadTestingGroups, handleTestingToggle, handleTestingExpand,
    handleRefreshTestingDetails, handleTestingToggleAll, handleSaveGlobalIntervals,
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
          const expanded = expandedTestingGroupId === row.group_id;
          const detailsLoading = testingDetailsLoadingGroupId === row.group_id;
          const details = testingDetailsByGroupId[row.group_id];
          const detailsError = details && details.error;
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
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleTestingExpand(row)}
                  >
                    {expanded ? "📋 Hide" : "📋 Details"}
                  </button>
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

              {expanded && (
                <div
                  style={{
                    marginTop: "6px",
                    paddingTop: "10px",
                    borderTop: "1px solid var(--border)",
                    display: "grid",
                    gap: "10px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                    <strong>📊 Live Status</strong>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleRefreshTestingDetails(row.group_id)}
                      disabled={detailsLoading}
                    >
                      {detailsLoading ? "Refreshing..." : "🔄 Refresh"}
                    </button>
                  </div>

                  {detailsLoading ? (
                    <div className="loading" style={{ justifyContent: "flex-start" }}>
                      <div className="spinner"></div>
                      Loading diagnostics...
                    </div>
                  ) : detailsError ? (
                    <div style={{ color: "var(--danger)", fontSize: "13px" }}>
                      {detailsError}
                    </div>
                  ) : details ? (
                    <>
                      <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                        <strong style={{ color: "var(--text-primary)" }}>Current load:</strong>{" "}
                        {details.pinned?.available ? "Pinned message found" : "No pinned message found"}
                        {details.pinned?.pinnedMessageId ? ` (ID: ${details.pinned.pinnedMessageId})` : ""}
                        {details.pinned?.source ? ` via ${details.pinned.source}` : ""}
                      </div>

                      {details.pinned?.preview && (
                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          Pinned preview: {details.pinned.preview}
                        </div>
                      )}
                      {details.pinned?.pickupSummary && (
                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          Pickup: {details.pinned.pickupSummary}
                        </div>
                      )}
                      {details.pinned?.deliverySummary && (
                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          Delivery: {details.pinned.deliverySummary}
                        </div>
                      )}
                      {details.pinned?.destinationQuery && (
                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          Destination query: {details.pinned.destinationQuery}
                        </div>
                      )}
                      {details.pinned?.parseModel && (
                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          Pinned parser model: {details.pinned.parseModel}
                        </div>
                      )}
                      {details.pinned?.parseError && (
                        <div style={{ fontSize: "13px", color: "var(--danger)" }}>
                          Pinned parser error: {details.pinned.parseError}
                        </div>
                      )}

                      <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "6px" }}>
                        <strong style={{ color: "var(--text-primary)" }}>Last ingested loads (chat listener, max 2)</strong>
                        <div style={{ marginTop: "6px", fontSize: "12px", lineHeight: 1.45 }}>
                          Saved automatically when dispatch sends PDF/image/photo or load-style text—does not require a pinned message.
                        </div>
                      </div>

                      {Array.isArray(details.recentLoads) && details.recentLoads.length > 0 ? (
                        <div style={{ display: "grid", gap: "10px" }}>
                          {details.recentLoads.map((load) => (
                            <div
                              key={load.id ?? load.telegramMessageId}
                              style={{
                                border: "1px solid var(--border)",
                                borderRadius: "10px",
                                padding: "10px 12px",
                                background: "var(--bg-primary)",
                                fontSize: "13px",
                                color: "var(--text-secondary)",
                              }}
                            >
                              <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: "6px" }}>
                                Telegram msg #{load.telegramMessageId}
                                {load.loadIdentifier ? ` · Load ${load.loadIdentifier}` : ""}
                                {load.createdAt ? (
                                  <span style={{ fontWeight: 400, color: "var(--text-secondary)" }}>
                                    {" "}
                                    · saved {timeAgo(load.createdAt)}
                                  </span>
                                ) : null}
                              </div>
                              {load.captionPreview ? (
                                <div style={{ marginBottom: "6px" }}>
                                  <strong style={{ color: "var(--text-primary)" }}>Caption:</strong>{" "}
                                  {load.captionPreview.length > 280 ? `${load.captionPreview.slice(0, 280)}…` : load.captionPreview}
                                </div>
                              ) : null}
                              {load.pickupSummary ? (
                                <div>
                                  <strong style={{ color: "var(--text-primary)" }}>Pickup:</strong> {load.pickupSummary}
                                </div>
                              ) : null}
                              {load.deliverySummary ? (
                                <div>
                                  <strong style={{ color: "var(--text-primary)" }}>Delivery:</strong> {load.deliverySummary}
                                </div>
                              ) : null}
                              {load.destinationQuery ? (
                                <div>
                                  <strong style={{ color: "var(--text-primary)" }}>Destination (routing):</strong>{" "}
                                  {load.destinationQuery}
                                </div>
                              ) : null}
                              <div style={{ marginTop: "6px", fontSize: "12px", opacity: 0.9 }}>
                                {(load.pickupWindowStart || load.pickupWindowEnd || load.deliveryWindowStart || load.deliveryWindowEnd) ? (
                                  <>
                                    <strong style={{ color: "var(--text-primary)" }}>Windows (parsed):</strong> PU{" "}
                                    {formatOptionalDateTime(load.pickupWindowStart)}
                                    {" → "}
                                    {formatOptionalDateTime(load.pickupWindowEnd)}
                                    {" · DEL "}
                                    {formatOptionalDateTime(load.deliveryWindowStart)}
                                    {" → "}
                                    {formatOptionalDateTime(load.deliveryWindowEnd)}
                                  </>
                                ) : (
                                  <span>No appointment windows parsed (fallback: newest load wins).</span>
                                )}
                              </div>
                              {load.aiModel ? (
                                <div style={{ marginTop: "4px", fontSize: "12px" }}>
                                  Model: {load.aiModel}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ fontSize: "13px", color: "var(--text-secondary)", fontStyle: "italic" }}>
                          No loads ingested yet for this group (send a rate con / load message while the bot is online).
                        </div>
                      )}

                      <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                        <strong style={{ color: "var(--text-primary)" }}>Current location:</strong>{" "}
                        {details.location?.available
                          ? `${details.location.address || `${details.location.latitude}, ${details.location.longitude}`} (${details.location.source})`
                          : `Unavailable${details.location?.error ? ` - ${details.location.error}` : ""}`}
                      </div>

                      {details.location?.available && (
                        <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", color: "var(--text-secondary)", fontSize: "13px" }}>
                          <span>Unit: {details.location.unitNumber || "-"}</span>
                          <span>Vehicle: {details.location.vehicleName || "-"}</span>
                          <span>
                            Coords: {Number.isFinite(details.location.latitude) ? details.location.latitude.toFixed(6) : "-"},{" "}
                            {Number.isFinite(details.location.longitude) ? details.location.longitude.toFixed(6) : "-"}
                          </span>
                          <span>Last ping: {details.location.pingAgeMinutes ?? "-"} min</span>
                        </div>
                      )}

                      <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                        <strong style={{ color: "var(--text-primary)" }}>Device status:</strong>
                      </div>
                      <div style={{ display: "grid", gap: "6px" }}>
                        {(details.providers || []).map((provider) => (
                          <div key={provider.label} style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                            {provider.label}:{" "}
                            <strong style={{ color: provider.connected ? "var(--success)" : "var(--danger)" }}>
                              {provider.connected ? "Connected" : "Not Connected"}
                            </strong>
                            {provider.error ? ` (${provider.error})` : ""}
                          </div>
                        ))}
                      </div>

                      <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                        <strong style={{ color: "var(--text-primary)" }}>ETA:</strong>{" "}
                        {details.eta?.available
                          ? `${details.eta.remainingMiles} mi, ${details.eta.etaMinutes} min (around ${details.eta.etaChicagoLabel} CT)`
                          : `Unavailable${details.eta?.error ? ` - ${details.eta.error}` : ""}`}
                      </div>
                      {details.eta?.destinationDisplayName && (
                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          ETA destination: {details.eta.destinationDisplayName}
                        </div>
                      )}

                      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", color: "var(--text-secondary)", fontSize: "13px" }}>
                        <span>
                          Auto Update:{" "}
                          <strong style={{ color: row.eta_enabled ? "var(--success)" : "var(--text-secondary)" }}>
                            {row.eta_enabled ? "On" : "Off"}
                          </strong>
                        </span>
                        <span>Interval: {formatIntervalText(row.eta_interval_minutes)}</span>
                        <span>Next run: {formatOptionalDateTime(row.eta_next_run_at, { future: true })}</span>
                      </div>
                    </>
                  ) : (
                    <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
                      No diagnostics loaded yet.
                    </div>
                  )}
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
