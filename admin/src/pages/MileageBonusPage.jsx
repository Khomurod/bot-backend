import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../api";
import useVisibleInterval from "../utils/useVisibleInterval";
import { fmtAmount, fmtDate, fmtMiles, StatusBadge } from "./mileageBonus/format";
import BonusNotificationsTable from "./mileageBonus/BonusNotificationsTable";


function ProgressBar({ current, target }) {
  const pct = target ? Math.min(100, Math.round((current / target) * 100)) : 100;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 160 }}>
      <div style={{ flex: 1, height: 8, borderRadius: 999, background: "var(--neutral-soft)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "var(--success-solid)" : "var(--accent)" }} />
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
  const [rowBusy, setRowBusy] = useState({});

  const withRowBusy = async (key, action) => {
    setRowBusy((current) => ({ ...current, [key]: true }));
    try {
      return await action();
    } finally {
      setRowBusy((current) => ({ ...current, [key]: false }));
    }
  };

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

  // Poll while a run is in progress so the table + cards refresh live — paused
  // while the browser tab is hidden.
  useVisibleInterval(load, 8000, Boolean(overview?.running));

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

  const handleDriverStatus = async (driver, nextStatus) => {
    if (nextStatus === "inactive" && !window.confirm(
      `Make ${driver.driver_name} inactive? Mileage calculation and new bonus messages will stop, and open Telegram bonus cards will be disregarded.`
    )) return;
    setStatus(null);
    try {
      const result = await withRowBusy(`driver:${driver.driver_normalized_name}`, () =>
        api.updateMileageBonusDriverStatus(driver.driver_normalized_name, nextStatus)
      );
      const cleanupErrors = (result.cleanedNotifications || [])
        .flatMap((item) => [item.error, item.cleanup?.error])
        .filter(Boolean);
      setStatus({
        type: cleanupErrors.length ? "error" : "success",
        text: `${driver.driver_name} is now ${nextStatus}.`
          + (cleanupErrors.length ? ` Telegram cleanup warning: ${cleanupErrors.join(" | ")}` : ""),
      });
      await load();
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    }
  };

  const handleResend = async (notification) => {
    if (!window.confirm(`Resend the ${fmtMiles(notification.threshold_miles)} mile bonus for ${notification.driver_name}?`)) return;
    setStatus(null);
    try {
      const result = await withRowBusy(`notification:${notification.id}`, () =>
        api.resendMileageBonusNotification(notification.id)
      );
      const cleanupWarning = result.cleanup?.error ? ` ${result.cleanup.error}` : "";
      setStatus({ type: cleanupWarning ? "error" : "success", text: `Bonus message resent.${cleanupWarning}` });
      await load();
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    }
  };

  const handleDisregard = async (notification) => {
    if (!window.confirm(`Disregard this bonus task for ${notification.driver_name} and remove its Telegram card?`)) return;
    setStatus(null);
    try {
      const result = await withRowBusy(`notification:${notification.id}`, () =>
        api.disregardMileageBonusNotification(notification.id)
      );
      const cleanupWarning = result.cleanup?.error ? ` ${result.cleanup.error}` : "";
      setStatus({
        type: cleanupWarning ? "error" : "success",
        text: `Bonus task disregarded.${cleanupWarning}`,
      });
      await load();
    } catch (err) {
      setStatus({ type: "error", text: err.message });
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

  const pendingNotifications = notifications.filter((n) => n.status === "pending");
  const decidedNotifications = notifications.filter((n) => n.status !== "pending");

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Mileage Bonuses</h2>
          <p style={{ color: "var(--text-muted)", margin: "4px 0 0" }}>
            Company drivers only · counting from {overview?.programStart || "2026-04-17"} → pay period{" "}
            {overview?.lastRun?.periodEnd ? `ending ${overview.lastRun.periodEnd}` : "(2 weeks behind)"} · cards go
            to the group set in <a href="#settings/groups">Settings → Bonus groups</a>
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
        {overview?.lastRunRecord?.status === "failed" && (
          <div style={{ marginTop: 10, fontSize: 13, color: "var(--danger)" }}>
            Last run failed: {overview.lastRunRecord.error || "Unknown error"}. It will retry automatically.
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
                <tr key={d.driver_normalized_name} style={{ opacity: d.is_active === false ? 0.62 : 1 }}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600 }}>{d.driver_name}</span>
                      <select
                        value={d.is_active === false ? "inactive" : "active"}
                        disabled={Boolean(rowBusy[`driver:${d.driver_normalized_name}`])}
                        onChange={(event) => handleDriverStatus(d, event.target.value)}
                        style={{ fontSize: 12, padding: "3px 6px" }}
                        aria-label={`Mileage status for ${d.driver_name}`}
                      >
                        {/* Not "Active/Inactive": that is Driver Groups' word for
                            whether someone still works here. This only says whether
                            they count for the mileage bonus. */}
                        <option value="active">In bonus program</option>
                        <option value="inactive">Excluded</option>
                      </select>
                    </div>
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
                      : <span style={{ color: "var(--success)" }}>All reached 🎉</span>}
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
                            ? <span title="Reached, not yet notified" style={{ color: "var(--warning)" }}>● ready</span>
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

      {/* What still needs a decision first; the decided ones (paid, rejected,
          disregarded) are history, collapsed with a count (November 2026). A
          long paid history used to sit between the page and the cards that
          still need someone. */}
      <h3 style={{ marginTop: 24 }}>Waiting for a decision{pendingNotifications.length ? ` (${pendingNotifications.length})` : ""}</h3>
      {notifications.length === 0 ? (
        <div className="card" style={{ color: "var(--text-muted)" }}>No bonus notifications sent yet.</div>
      ) : pendingNotifications.length === 0 ? (
        <div className="card" style={{ color: "var(--text-muted)" }}>Nothing is waiting — every card sent has been decided.</div>
      ) : <BonusNotificationsTable rows={pendingNotifications} rowBusy={rowBusy} onResend={handleResend} onDisregard={handleDisregard} />}
      {decidedNotifications.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>History ({decidedNotifications.length})</summary>
          <div style={{ marginTop: 8 }}>{<BonusNotificationsTable rows={decidedNotifications} rowBusy={rowBusy} onResend={handleResend} onDisregard={handleDisregard} />}</div>
        </details>
      )}
    </div>
  );
}
