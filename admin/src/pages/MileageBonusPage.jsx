import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../api";

const STATUS_BADGE = {
  pending: { label: "Pending", bg: "rgba(245,158,11,0.18)", color: "#f59e0b" },
  paid: { label: "Paid", bg: "rgba(34,197,94,0.18)", color: "#22c55e" },
  rejected: { label: "Rejected", bg: "rgba(239,68,68,0.18)", color: "#ef4444" },
};

function fmtMiles(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US");
}

function fmtAmount(value) {
  return `$${(Math.round(Number(value) || 0)).toLocaleString("en-US")}`;
}

function fmtDate(value) {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

function StatusBadge({ status }) {
  const cfg = STATUS_BADGE[status] || { label: status || "—", bg: "rgba(148,163,184,0.18)", color: "#94a3b8" };
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 10px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 600,
      background: cfg.bg,
      color: cfg.color,
    }}>
      {cfg.label}
    </span>
  );
}

function ProgressBar({ current, target }) {
  const pct = target ? Math.min(100, Math.round((current / target) * 100)) : 100;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 160 }}>
      <div style={{ flex: 1, height: 8, borderRadius: 999, background: "rgba(148,163,184,0.25)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "#22c55e" : "#6366f1" }} />
      </div>
      <span style={{ fontSize: 12, color: "var(--text-muted)", width: 36, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}

export default function MileageBonusPage() {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getMileageBonusOverview();
      setOverview(data);
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while a run is in progress so the table + cards refresh live.
  useEffect(() => {
    if (!overview?.running) return undefined;
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [overview?.running, load]);

  const handleRun = async () => {
    if (!window.confirm(
      "Run the bonus check now? This goes through all company drivers and sends "
      + "a notification card to the Bonus Penalty For Drivers group for every "
      + "driver who has reached a milestone and hasn't been notified yet."
    )) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.runMileageBonusCheck();
      setStatus({ type: "success", text: "Bonus check started. Sending cards to the group… this can take a couple of minutes." });
      setTimeout(load, 2000);
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await api.refreshMileageBonusProgress();
      setStatus({ type: "success", text: "Recomputing mileage from Datatruck (no notifications)… refresh in a moment." });
      setTimeout(load, 2000);
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const tiers = overview?.tiers || [];
  const progress = overview?.progress || [];
  const notifications = overview?.notifications || [];

  // Index notifications by driver+threshold for per-tier status lookups.
  const notifByKey = useMemo(() => {
    const map = new Map();
    for (const n of notifications) {
      map.set(`${n.driver_normalized_name}|${n.threshold_miles}`, n);
    }
    return map;
  }, [notifications]);

  if (loading) {
    return <div className="loading"><div className="spinner"></div> Loading…</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>🏁 Mileage Bonuses</h2>
          <p style={{ color: "var(--text-muted)", margin: "4px 0 0" }}>
            Company drivers only · counting from {overview?.programStart || "2026-04-17"} → pay period{" "}
            {overview?.lastRun?.periodEnd ? `ending ${overview.lastRun.periodEnd}` : "(2 weeks behind)"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost" onClick={handleRefresh} disabled={busy || overview?.running}>
            ↻ Refresh data
          </button>
          <button className="btn btn-primary" onClick={handleRun} disabled={busy || overview?.running}>
            {overview?.running ? "Running…" : "Run check & notify"}
          </button>
        </div>
      </div>

      {!overview?.configured && (
        <div className="alert alert-warning" style={{ marginBottom: 16 }}>
          Datatruck API is not configured yet. Add <code>DATATRUCK_API_TOKEN</code> (and{" "}
          <code>DATATRUCK_COMPANY</code>) to the environment to enable mileage tracking.
        </div>
      )}

      {status && (
        <div className={`alert alert-${status.type === "error" ? "danger" : "success"}`} style={{ marginBottom: 16 }}>
          {status.text}
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
          <strong>Bonus tiers:</strong>
          {tiers.map((t) => (
            <span key={t.miles} style={{ fontSize: 14 }}>
              {fmtMiles(t.miles)} mi → <b>{fmtAmount(t.amount)}</b>
            </span>
          ))}
        </div>
        {overview?.lastRun && (
          <div style={{ marginTop: 10, fontSize: 13, color: "var(--text-muted)" }}>
            Last run ({overview.lastRun.trigger}): {overview.lastRun.companyDrivers} company drivers,{" "}
            {overview.lastRun.notificationsSentCount} new notification(s)
            {overview.lastRun.errors?.length ? `, ${overview.lastRun.errors.length} error(s)` : ""} ·{" "}
            {overview.lastRun.ranAt ? new Date(overview.lastRun.ranAt).toLocaleString() : ""}
          </div>
        )}
      </div>

      <h3>Driver progress</h3>
      {progress.length === 0 ? (
        <div className="card" style={{ color: "var(--text-muted)" }}>
          No data yet. Click <b>Refresh data</b> or <b>Run check &amp; notify</b> to pull mileage from Datatruck.
        </div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Driver</th>
                <th style={{ textAlign: "right" }}>Total miles</th>
                <th style={{ textAlign: "left" }}>Next milestone</th>
                <th style={{ textAlign: "left", minWidth: 180 }}>Progress to next</th>
                {tiers.map((t) => (
                  <th key={t.miles} style={{ textAlign: "center" }}>{fmtMiles(t.miles)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {progress.map((d) => (
                <tr key={d.driver_normalized_name}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d.driver_name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      since {fmtDate(d.period_start)} · {d.trips || 0} trips
                    </div>
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                    {fmtMiles(d.total_miles)}
                  </td>
                  <td>
                    {d.next_tier
                      ? <>{fmtMiles(d.next_tier)} mi <span style={{ color: "var(--text-muted)", fontSize: 12 }}>({fmtMiles(d.miles_to_next_tier)} to go)</span></>
                      : <span style={{ color: "#22c55e" }}>All reached 🎉</span>}
                  </td>
                  <td>
                    <ProgressBar current={Number(d.total_miles)} target={d.next_tier || d.highest_tier_reached || 1} />
                  </td>
                  {tiers.map((t) => {
                    const reached = Number(d.total_miles) >= t.miles;
                    const notif = notifByKey.get(`${d.driver_normalized_name}|${t.miles}`);
                    return (
                      <td key={t.miles} style={{ textAlign: "center" }}>
                        {notif
                          ? <StatusBadge status={notif.status} />
                          : reached
                            ? <span title="Reached, not yet notified" style={{ color: "#f59e0b" }}>● ready</span>
                            : <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>Bonus notifications</h3>
      {notifications.length === 0 ? (
        <div className="card" style={{ color: "var(--text-muted)" }}>No bonus notifications sent yet.</div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Driver</th>
                <th style={{ textAlign: "right" }}>Milestone</th>
                <th style={{ textAlign: "right" }}>Bonus</th>
                <th style={{ textAlign: "right" }}>Miles at notify</th>
                <th style={{ textAlign: "left" }}>Status</th>
                <th style={{ textAlign: "left" }}>Decided by</th>
                <th style={{ textAlign: "left" }}>Sent</th>
              </tr>
            </thead>
            <tbody>
              {notifications.map((n) => (
                <tr key={n.id}>
                  <td style={{ fontWeight: 600 }}>{n.driver_name}</td>
                  <td style={{ textAlign: "right" }}>{fmtMiles(n.threshold_miles)} mi</td>
                  <td style={{ textAlign: "right" }}>{fmtAmount(n.bonus_amount)}</td>
                  <td style={{ textAlign: "right" }}>{fmtMiles(n.miles_at_notification)}</td>
                  <td><StatusBadge status={n.status} /></td>
                  <td>{n.decided_by_username ? `@${n.decided_by_username}` : "—"}</td>
                  <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {n.created_at ? new Date(n.created_at).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
