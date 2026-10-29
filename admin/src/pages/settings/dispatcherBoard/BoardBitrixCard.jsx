import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../../api";

/**
 * Settings → Dispatcher Board → Board ↔ Bitrix check.
 *
 * The Board is the source of truth. Every 15 minutes Wenze compares it with
 * Bitrix24 — active drivers in DRIVER RELATION, their trucks, their status —
 * and asks about each difference, ONE AT A TIME, in the Needs-attention group.
 * The owner fixes Bitrix and replies "done"; Wenze checks again, confirms and
 * asks the next. Bitrix is only read.
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
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <strong style={tone ? { color: tone } : undefined}>{value}</strong>
    </div>
  );
}

const STATUS_TONE = { ok: "#22c55e", error: "#ef4444", blocked: "#f59e0b", skipped: "#94a3b8" };

function LastRun({ run }) {
  if (!run) return <div style={{ fontSize: 13, color: "#94a3b8" }}>No check has run yet.</div>;
  return (
    <>
      <Row label="Last check" value={run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "running"} />
      <Row label="Result" value={run.status || "—"} tone={STATUS_TONE[run.status]} />
      {run.error && <div style={{ fontSize: 12, color: "#f59e0b", margin: "4px 0" }}>{run.error}</div>}
      {run.status === "ok" && (
        <>
          <Row label="Drivers on the Board" value={run.boardDrivers} />
          <Row label="Active drivers in Bitrix" value={run.activeDeals} />
          <Row label="Trucks on the road in Bitrix" value={run.activeTrucks} />
          <Row label="Matched" value={run.paired} />
          <Row label="Differences found" value={run.differences} />
        </>
      )}
    </>
  );
}

export default function BoardBitrixCard() {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      setView(await api.getBoardBitrixCheck());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (enabled) => {
    setBusy(true); setMessage(null);
    try {
      setView(await api.setBoardBitrixCheckEnabled(enabled));
      setMessage(enabled ? "On — the first check is running now." : "Off — nothing more will be asked.");
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

  if (error) {
    return (
      <div className="ios-glass" style={{ padding: 14, marginTop: 16 }}>
        <div className="alert alert-error" role="alert">{error}</div>
        <button className="btn btn-ghost touch-target" onClick={load}>Try again</button>
      </div>
    );
  }
  if (!view) return <div style={{ padding: 14, color: "#94a3b8" }}>Reading the Board ↔ Bitrix check…</div>;

  const c = view.counts || {};
  return (
    <div className="ios-glass" style={{ padding: 14, marginTop: 16 }} data-testid="board-bitrix-card">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Board ↔ Bitrix check</div>
      <p style={{ color: "#94a3b8", fontSize: 13, marginTop: 0 }}>
        Compares the board (the source of truth) with Bitrix24 — active drivers, their trucks and
        their status — every 15 minutes, and asks about each difference <strong>one at a time</strong> in
        the Needs-attention group. Fix Bitrix, reply <strong>done</strong> to the question, and Wenze checks
        again and asks the next. Bitrix is only read.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, marginBottom: 10 }}>
        <input type="checkbox" aria-label="Board ↔ Bitrix check on" checked={view.enabled} disabled={busy}
          onChange={(e) => toggle(e.target.checked)} />
        {view.enabled ? "Check is ON" : "Check is OFF"}
      </label>

      <Row label="Question out now" value={view.current ? `${view.current.label} (since ${new Date(view.current.askedAt).toLocaleString()})` : "none"} />
      <Row label="Waiting to be asked" value={c.waiting ?? 0} />
      <Row label="Skipped until tomorrow" value={c.skipped ?? 0} />
      <Row label="Confirmed fixed after “done”" value={c.confirmed ?? 0} />
      <Row label="Fixed without a reply" value={c.fixedWithoutReply ?? 0} />
      {view.byKind?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#94a3b8" }}>
          Open: {view.byKind.map((k) => `${k.label} ${k.count}`).join(" · ")}
        </div>
      )}

      <div style={{ marginTop: 10 }}><LastRun run={view.lastRun} /></div>

      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-ghost touch-target" onClick={checkNow} disabled={busy || !view.enabled}>
          {busy ? "Checking…" : "Check now"}
        </button>
        {message && <span style={{ fontSize: 12, color: "#94a3b8" }}>{message}</span>}
      </div>
    </div>
  );
}
