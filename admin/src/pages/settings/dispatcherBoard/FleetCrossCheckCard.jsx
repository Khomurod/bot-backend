import React, { useState } from "react";
import * as api from "../../../api";

/**
 * Settings → Dispatcher Board → Compare with Wenze and Datatruck.
 *
 * Each board truck beside what Wenze and Datatruck hold for the same truck
 * (fleet AND number — Company 313 and Owner-operator 313 are two trucks), and
 * what disagrees. The owner's request of 5 November 2026: two sources only say
 * that one of them is wrong; a third says which.
 *
 * READ-ONLY, and NAMES ONLY ON REQUEST. Unlike the Feed card above, this one
 * has to show drivers' names — a name that differs is the finding — so nothing
 * is read until "Compare" is pressed. No phone number, ever.
 */

const FLEET = { company: "Company", owner_operator: "Owner-op", lease: "Lease", unknown: "?" };

const PROBLEM = {
  not_in_wenze: "Not in Wenze",
  fleet_differs_wenze: "Wenze has it under another fleet",
  name_differs_wenze: "Different driver in Wenze",
  name_close_wenze: "Name spelled differently in Wenze",
  not_in_datatruck: "No load in Datatruck this week",
  fleet_differs_datatruck: "Datatruck has another driver type",
  name_differs_datatruck: "Different driver in Datatruck",
};

function Stat({ label, value, warn }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 13 }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <strong style={warn && value > 0 ? { color: "var(--warning)" } : undefined}>{value}</strong>
    </div>
  );
}

function wenzeCell(w) {
  if (!w.holders.length && !w.otherFleets.length) return "—";
  const same = w.holders.map((h) => `${FLEET[h.fleetType] || h.fleetType} · ${h.name}`);
  const other = w.otherFleets.map((h) => `(${FLEET[h.fleetType] || h.fleetType} · ${h.name})`);
  return [...same, ...other].join("; ");
}

function datatruckCell(d) {
  if (!d.read) return "not read";
  if (!d.label) return "—";
  const types = d.driverTypes.length ? ` · ${d.driverTypes.join(", ")}` : "";
  return `${d.label}: ${d.drivers.join(" / ") || "no driver"}${types}`;
}

export default function FleetCrossCheckCard() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [onlyProblems, setOnlyProblems] = useState(true);

  const run = async (refresh) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.getFleetCrossCheck({ refresh }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const s = report?.summary || {};
  const rows = (report?.rows || []).filter((r) => !onlyProblems || r.problems.length);

  return (
    <div className="ios-glass" style={{ padding: 14, marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Compare with Wenze and Datatruck</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
        Each board truck beside what Wenze and Datatruck hold for the same truck (fleet and number).
        Read-only — nothing is changed.
      </div>
      <button className="btn btn-ghost touch-target" onClick={() => run(Boolean(report))} disabled={loading}>
        {loading ? "Comparing…" : report ? "Compare again" : "Compare"}
      </button>
      {error && <div className="alert alert-error" style={{ marginTop: 10 }}>{error}</div>}
      {report && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
            Built {new Date(report.builtAt).toLocaleString()}
            {report.refreshRefused ? ` — ${report.refreshRefused}` : ""}
          </div>
          {!report.datatruck?.read && (
            <div className="alert alert-warning" style={{ marginBottom: 8 }}>
              {report.datatruck?.reason || "Datatruck was not read."} The Wenze half below still stands.
            </div>
          )}
          <Stat label="Board trucks" value={s.boardRows ?? 0} />
          <Stat label="All sources agree" value={s.allAgree ?? 0} />
          <Stat label="Not in Wenze" value={s.notInWenze ?? 0} warn />
          <Stat label="Wenze has another fleet" value={s.fleetDiffersWenze ?? 0} warn />
          <Stat label="Different driver in Wenze" value={s.nameDiffersWenze ?? 0} warn />
          <Stat label="Name spelled differently in Wenze" value={s.nameCloseWenze ?? 0} warn />
          {s.datatruckRead && (
            <>
              <Stat label="No load in Datatruck this week" value={s.notInDatatruck ?? 0} warn />
              <Stat label="Datatruck has another driver type" value={s.fleetDiffersDatatruck ?? 0} warn />
              <Stat label="Different driver in Datatruck" value={s.nameDiffersDatatruck ?? 0} warn />
            </>
          )}
          <label style={{ display: "flex", gap: 6, alignItems: "center", margin: "10px 0", fontSize: 13 }}>
            <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
            Only trucks where something differs
          </label>
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ fontSize: 12, width: "100%" }}>
              <thead>
                <tr><th>Truck</th><th>Board</th><th>Wenze</th><th>Datatruck</th><th>What differs</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.truck}|${r.board.names.join("/")}`}>
                    <td>{r.truck}</td>
                    <td>{FLEET[r.board.fleetType] || r.board.fleetType} · {r.board.names.join(" / ") || "—"}</td>
                    <td>{wenzeCell(r.wenze)}</td>
                    <td>{datatruckCell(r.datatruck)}</td>
                    <td>{r.problems.length ? r.problems.map((p) => PROBLEM[p] || p).join("; ") : "✓"}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={5} style={{ color: "var(--text-muted)" }}>Nothing differs.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
