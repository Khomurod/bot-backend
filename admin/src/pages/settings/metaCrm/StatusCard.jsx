import React from "react";

/**
 * What is in effect now: the ON/OFF switch, which dataset and where it comes
 * from, whether a token is set (its last four characters only), and the last
 * pass from the run ledger in plain words.
 */

const SOURCE = {
  database: "saved in this panel",
  environment: "from the server's environment variable",
  none: "not set",
};

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");

function LastRun({ run }) {
  if (!run) {
    return <div style={{ fontSize: 13, color: "#94a3b8" }}>No pass has run yet. The first runs a few minutes after the server starts, then every 15 minutes.</div>;
  }
  const status = {
    ok: "✅ ran normally",
    error: "❌ failed",
    blocked: "⏸ waiting",
    skipped: "skipped",
  }[run.status] || run.status;
  const counts = run.status === "blocked" ? null
    : `${run.sent ?? 0} event(s) sent to Meta, ${run.failed ?? 0} failed`
      + `${run.recorded ? `, ${run.recorded} new` : ""}${run.deals != null ? ` · ${run.deals} deal(s) looked at` : ""}`;
  return (
    <div style={{ fontSize: 13 }}>
      <div>Last pass: <strong>{status}</strong> · {when(run.finishedAt)}</div>
      {counts && <div style={{ marginTop: 2 }}>{counts}</div>}
      {run.error && (
        <div style={{ marginTop: 4, color: run.status === "error" ? "#f87171" : "#94a3b8" }}>
          {run.status === "blocked" ? "Why: " : "Last error: "}{run.error}
        </div>
      )}
    </div>
  );
}

export default function StatusCard({ settings, onToggle, toggling }) {
  const on = Boolean(settings.enabled);
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Status</h3>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
          <input type="checkbox" checked={on} disabled={toggling} onChange={(e) => onToggle(e.target.checked)} aria-label="Sync on" />
          {on ? "Sync is ON" : "Sync is OFF"}
        </label>
      </div>
      {on && !settings.configured && (
        <div className="alert alert-error" style={{ marginTop: 10 }}>
          The sync is on but has nothing to send with: enter the dataset ID and token below, test them, then save.
        </div>
      )}
      <div style={{ fontSize: 14, marginTop: 10, lineHeight: 1.7 }}>
        <div>Dataset ID: <strong>{settings.datasetId || "—"}</strong> <span style={{ color: "#94a3b8" }}>({SOURCE[settings.datasetSource] || settings.datasetSource})</span></div>
        <div>
          Access token: <strong>{settings.tokenSet ? settings.tokenMasked : "not set"}</strong>{" "}
          <span style={{ color: "#94a3b8" }}>({SOURCE[settings.tokenSource] || settings.tokenSource})</span>
        </div>
        {settings.updatedAt && settings.updatedBy && (
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Last changed {when(settings.updatedAt)} by {settings.updatedBy}</div>
        )}
      </div>
      {settings.tokenUnreadable && (
        <div className="alert alert-error" style={{ marginTop: 10 }}>
          A token is saved but this server cannot decrypt it (its encryption key changed). Paste the token again, test it and save.
        </div>
      )}
      <div style={{ marginTop: 12 }}><LastRun run={settings.lastRun} /></div>
    </div>
  );
}
