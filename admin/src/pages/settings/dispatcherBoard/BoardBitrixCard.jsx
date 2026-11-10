import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../../api";

/**
 * Settings → Dispatcher Board → Board ↔ Bitrix check.
 *
 * The Board is the source of truth. Every 15 minutes Wenze compares it with
 * Bitrix24 — active drivers in DRIVER RELATION, their trucks, their status —
 * and asks about each difference, ONE AT A TIME, in the Needs-attention group.
 * The owner can keep this read-only, record a dry run, or explicitly enable a
 * guarded STAGE_ID sync after the current Bitrix schema has been validated.
 *
 * COUNTS ONLY, like the Feed card above: no driver name, no truck number. The
 * questions themselves are in the group.
 *
 * A failed read shows the failure and a retry, never a switch drawn from
 * defaults.
 */

function Row({ label, value, tone }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <strong style={tone ? { color: tone } : undefined}>{value}</strong>
    </div>
  );
}

const STATUS_TONE = { ok: "var(--success)", error: "var(--danger)", blocked: "var(--warning)", skipped: "var(--text-muted)" };

function LastRun({ run }) {
  if (!run) return <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No check has run yet.</div>;
  return (
    <>
      <Row label="Last check" value={run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "running"} />
      <Row label="Result" value={run.status || "—"} tone={STATUS_TONE[run.status]} />
      {run.error && <div style={{ fontSize: 12, color: "var(--warning)", margin: "4px 0" }}>{run.error}</div>}
      {run.status === "ok" && (
        <>
          <Row label="Drivers on the Board" value={run.boardDrivers} />
          <Row label="Active drivers in Bitrix" value={run.activeDeals} />
          <Row label="Trucks on the road in Bitrix" value={run.activeTrucks} />
          <Row label="Matched" value={run.paired} />
          <Row label="Differences found" value={run.differences} />
          <Row label="Status sync" value={`${run.syncMode || "off"} · ${run.syncApplied || 0} applied · ${run.syncFailed || 0} failed`} />
          {(run.syncIdentitySkipped || 0) > 0 && <Row label="Status changes needing review" value={run.syncIdentitySkipped} />}
          <Row label="Schema" value={run.schemaWriteSafe ? `${run.schemaSource || "validated"} · safe for writes` : "read-only fallback"} />
          {run.syncBlocked && <div style={{ fontSize: 12, color: "var(--warning)", marginTop: 4 }}>{run.syncBlocked}</div>}
        </>
      )}
    </>
  );
}

/** The previously verified active truck stages, as the last check found them in Bitrix. */
function HistoricalStages({ stages }) {
  if (!stages || !stages.length) return null;
  return (
    <div>
      Previously verified active truck stages: {stages.map((stage) => (stage.present
        ? `${stage.label || stage.code} (${stage.itemCount})`
        : `${stage.code} — not in Bitrix`)).join(" · ")}
    </div>
  );
}

function SchemaCandidate({ candidate, busy, onApprove }) {
  if (!candidate) return null;
  const evidence = candidate.evidence || {};
  const populated = evidence.populatedStages || [];
  if (candidate.state === "invalid") {
    return (
      <div role="status" style={{ fontSize: 12, color: "var(--warning)", marginTop: 5 }}>
        <div>Writes and comparison are blocked: {candidate.problem || "the live catalogue could not be proven"}</div>
        {populated.length > 0 && (
          <div>
            Populated Bitrix truck stages: {populated.map((stage) =>
              `${stage.label}${stage.category ? ` / ${stage.category}` : ""} (${stage.itemCount})`).join(" · ")}
          </div>
        )}
        <HistoricalStages stages={evidence.historicalStages} />
      </div>
    );
  }
  const labels = candidate.labels || {};
  return (
    <div role="status" style={{ fontSize: 12, color: "var(--warning)", marginTop: 7 }}>
      <div>
        Candidate schema: {candidate.source || "catalogue"}
        {candidate.confidence != null ? ` (${candidate.confidence}%)` : ""}
        {` · seen ${candidate.seenCount || 0}/2`}
      </div>
      <div>
        {labels.driverPipeline || "driver pipeline"} → {labels.truckProcess || "Trucks"}
        {labels.truckCategory ? ` / ${labels.truckCategory}` : ""}
      </div>
      <div>
        Evidence: {evidence.selectedActiveItems || 0} active of {evidence.selectedCategoryItems || 0} items
        {(labels.activeTruckStages || []).length ? ` · ${labels.activeTruckStages.join(", ")}` : ""}
      </div>
      <HistoricalStages stages={evidence.historicalStages} />
      {candidate.problem && <div>{candidate.problem}</div>}
      {candidate.requiresApproval && (
        <button className="btn btn-ghost touch-target" style={{ marginTop: 5 }}
          disabled={busy || !candidate.readyToApprove} onClick={onApprove}>
          {candidate.readyToApprove ? "Approve schema" : "Check again before approval"}
        </button>
      )}
      {!candidate.requiresApproval && candidate.seenCount < 2 && (
        <div>Run Check now once more. The same result must be observed twice.</div>
      )}
    </div>
  );
}

export default function BoardBitrixCard() {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [syncMode, setSyncMode] = useState("off");
  const [maxUpdates, setMaxUpdates] = useState(10);

  const load = useCallback(async () => {
    try {
      const next = await api.getBoardBitrixCheck();
      setView(next);
      setSyncMode(next.syncMode || "off");
      setMaxUpdates(next.maxUpdatesPerPass || 10);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (enabled) => {
    setBusy(true); setMessage(null);
    try {
      const next = await api.setBoardBitrixCheckEnabled(enabled);
      setView(next);
      setSyncMode(next.syncMode || "off");
      setMaxUpdates(next.maxUpdatesPerPass || 10);
      setMessage(enabled
        ? "On — the first check is running now. Automatic status sync remains off until separately enabled."
        : "Off — questions and automatic status sync stopped; sync mode was reset to Off.");
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  };

  const checkNow = async () => {
    setBusy(true); setMessage(null);
    try {
      const out = await api.runBoardBitrixCheck();
      setView(out.settings);
      const s = out.summary || {};
      setMessage(s.error || s.blocked || `Checked: ${s.discrepancies ?? 0} difference(s).`);
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  };

  const saveSync = async () => {
    let confirmLive = false;
    if (syncMode === "live") {
      confirmLive = window.confirm(
        "Enable live Board → Bitrix status sync? Wenze will update STAGE_ID only after strict name + exact fleet/unit matching, a 20-minute settled Board status, and fresh Board and Bitrix re-checks."
      );
      if (!confirmLive) return;
    }
    setBusy(true); setMessage(null);
    try {
      const next = await api.setBoardBitrixSync({
        syncMode,
        maxUpdatesPerPass: Number(maxUpdates),
        confirmLive,
      });
      setView(next);
      setSyncMode(next.syncMode || "off");
      setMaxUpdates(next.maxUpdatesPerPass || 10);
      setMessage(syncMode === "live"
        ? "Live sync enabled — a guarded check is running now."
        : syncMode === "dry_run" ? "Dry run enabled — Bitrix will not be changed." : "Automatic status sync is off.");
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  };

  const approveSchema = async () => {
    if (!window.confirm("Approve this twice-observed Bitrix schema? Live status sync will remain Off.")) return;
    setBusy(true); setMessage(null);
    try {
      const next = await api.approveBoardBitrixSchema();
      setView(next);
      setSyncMode(next.syncMode || "off");
      setMessage("Schema approved. Live sync remains Off; a fresh check is running now.");
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  };

  if (error) {
    return (
      <div className="ios-glass" style={{ padding: 14, marginTop: 16 }}>
        <div className="alert alert-error" role="alert">{error}</div>
        <button className="btn btn-ghost touch-target" onClick={load}>Try again</button>
      </div>
    );
  }
  if (!view) return <div style={{ padding: 14, color: "var(--text-muted)" }}>Reading the Board ↔ Bitrix check…</div>;

  const c = view.counts || {};
  return (
    <div className="ios-glass" style={{ padding: 14, marginTop: 16 }} data-testid="board-bitrix-card">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Board ↔ Bitrix check</div>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 0 }}>
        Compares the board (the source of truth) with Bitrix24 — active drivers, their trucks and
        their status — every 15 minutes. Read-only mode asks about differences one at a time.
        Dry run records the exact HOME/WORKING changes without writing. Live mode changes only
        <strong> STAGE_ID</strong>, after a fresh schema and deal check.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, marginBottom: 10 }}>
        <input type="checkbox" aria-label="Board ↔ Bitrix check on" checked={view.enabled} disabled={busy}
          onChange={(e) => toggle(e.target.checked)} />
        {view.enabled ? "Check is ON" : "Check is OFF"}
      </label>

      <div style={{ margin: "10px 0", padding: 10, border: "1px solid var(--border)", borderRadius: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Automatic Board → Bitrix status</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
          <label style={{ fontSize: 12 }}>
            Mode
            <select aria-label="Board Bitrix sync mode" value={syncMode} disabled={busy}
              onChange={(e) => setSyncMode(e.target.value)} style={{ display: "block", marginTop: 3 }}>
              <option value="off">Off — questions only</option>
              <option value="dry_run">Dry run — record only</option>
              <option value="live">Live — update STAGE_ID</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>
            Stop if more than
            <input aria-label="Maximum Bitrix updates per pass" type="number" min="1" max="25"
              value={maxUpdates} disabled={busy} onChange={(e) => setMaxUpdates(e.target.value)}
              style={{ display: "block", width: 80, marginTop: 3 }} />
          </label>
          <button className="btn btn-ghost touch-target" onClick={saveSync} disabled={busy}>Save mode</button>
        </div>
        <Row label="Last schema check" value={view.schema?.checkedAt ? new Date(view.schema.checkedAt).toLocaleString() : "not checked"} />
        <Row label="Schema source" value={view.schema?.writeSafe
          ? `${view.schema.source}${view.schema.confidence != null ? ` (${view.schema.confidence}%)` : ""}`
          : "not validated for writes"} />
        {view.schema?.problem && !view.schema?.candidate && (
          <div role="status" style={{ fontSize: 12, color: "var(--warning)", marginTop: 5 }}>
            Writes are blocked: {view.schema.problem}
          </div>
        )}
        <SchemaCandidate candidate={view.schema?.candidate} busy={busy} onApprove={approveSchema} />
      </div>

      <Row label="Question out now" value={view.current ? `${view.current.label} (since ${new Date(view.current.askedAt).toLocaleString()})` : "none"} />
      <Row label="Waiting to be asked" value={c.waiting ?? 0} />
      <Row label="Skipped until tomorrow" value={c.skipped ?? 0} />
      <Row label="Confirmed fixed after “done”" value={c.confirmed ?? 0} />
      <Row label="Fixed without a reply" value={c.fixedWithoutReply ?? 0} />
      {view.byKind?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>
          Open: {view.byKind.map((k) => `${k.label} ${k.count}`).join(" · ")}
        </div>
      )}

      <div style={{ marginTop: 10 }}><LastRun run={view.lastRun} /></div>

      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-ghost touch-target" onClick={checkNow} disabled={busy || !view.enabled}>
          {busy ? "Checking…" : "Check now"}
        </button>
        {message && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{message}</span>}
      </div>
    </div>
  );
}
