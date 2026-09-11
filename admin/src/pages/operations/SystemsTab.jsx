import React, { useCallback, useEffect, useState } from "react";

import * as api from "../../api";
import useVisibleInterval from "../../utils/useVisibleInterval";

/**
 * What is actually running.
 *
 * THE QUESTION EVERY OTHER SCREEN ANSWERS WRONG BY ACCIDENT. The rest of this
 * admin shows what a feature FOUND. None of it shows whether the feature ran —
 * and a pass that finds nothing writes nothing, so an empty Needs Attention
 * list and a fuel watch whose timer died after the last deploy look identical.
 * This company has already lost weeks of staff alerts to exactly that: an
 * unconfigured destination silently discarded every notice while every feature
 * reported success.
 *
 * SEVEN STATES, and the two an operator must be able to tell apart at a glance
 * are `stale_stopped` — it is not failing, it is not running — and
 * `needs_human_attention`, which is nearly always "nobody has configured this
 * yet" and names the missing thing in its reason. The second is the one with
 * something to DO, so it is sorted first and the reason is the loudest text on
 * the row.
 *
 * There is no restart button and no retry, deliberately. See `api/systems.js`.
 */
const STATE = {
  needs_human_attention: { label: "Needs a person", colour: "#dc2626", rank: 0 },
  stale_stopped: { label: "Stopped", colour: "#dc2626", rank: 1 },
  repeatedly_failing: { label: "Failing", colour: "#ea580c", rank: 2 },
  degraded: { label: "Blipped", colour: "#d97706", rank: 3 },
  cannot_determine: { label: "Not reported", colour: "#64748b", rank: 4 },
  recovered_automatically: { label: "Recovered by itself", colour: "#0891b2", rank: 5 },
  healthy: { label: "Working", colour: "#16a34a", rank: 6 },
};

const GROUP_LABEL = {
  integration: "Integrations",
  queue: "Queues",
  engine: "Operational engines",
  routine: "Routine work",
};

function ago(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "never";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function Tile({ label, value, colour }) {
  return (
    <div style={{
      flex: "1 1 120px", padding: "10px 12px", borderRadius: 8,
      border: "1px solid rgba(148,163,184,0.25)",
    }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: colour || "inherit" }}>{value ?? 0}</div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
    </div>
  );
}

function Row({ row }) {
  const state = STATE[row.state] || STATE.cannot_determine;
  const acts = row.state === "needs_human_attention" || row.state === "stale_stopped"
    || row.state === "repeatedly_failing";
  return (
    <div style={{
      border: "1px solid rgba(148,163,184,0.25)",
      borderLeft: `3px solid ${state.colour}`,
      background: acts ? "rgba(220,38,38,0.06)" : "transparent",
      borderRadius: 8, padding: "8px 12px", marginBottom: 6,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 300px", minWidth: 0 }}>
          <strong>{row.label || row.component}</strong>{" "}
          <span style={{ fontSize: 12, color: state.colour }}>· {state.label}</span>
          {row.critical ? null : (
            <span className="muted" style={{ fontSize: 11 }}> · not critical</span>
          )}
          {/* The reason is the whole value of the row when something is wrong:
              "no Google Maps key configured" is an instruction, "failing" is
              not. */}
          <div className={acts ? undefined : "muted"} style={{ fontSize: 13, marginTop: 2 }}>
            {row.reason || "—"}
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, textAlign: "right", flex: "0 0 auto" }}>
          <div>last pass {ago(row.lastRunAt)}</div>
          {row.consecutiveFailures > 0 && (
            <div style={{ color: "#ea580c" }}>{row.consecutiveFailures} failures in a row</div>
          )}
          {row.runsTotal > 0 && <div>{row.runsTotal} passes recorded</div>}
        </div>
      </div>
    </div>
  );
}

export default function SystemsTab({ flash }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.getSystems());
      setFailure(null);
    } catch (err) {
      // Kept BESIDE the last good data rather than replacing it — an empty page
      // presented as normal is the failure this whole tab exists to remove.
      setFailure(err.message || "Could not load the system state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, 60000);

  if (loading && !data) return <div className="muted">Loading…</div>;

  const components = data?.components || [];
  const sorted = [...components].sort((a, b) => {
    const ra = (STATE[a.state] || STATE.cannot_determine).rank;
    const rb = (STATE[b.state] || STATE.cannot_determine).rank;
    if (ra !== rb) return ra - rb;
    return (a.label || "").localeCompare(b.label || "");
  });
  const groups = ["integration", "queue", "engine", "routine"];

  return (
    <div>
      {failure && (
        <div style={{
          border: "1px solid #dc2626", borderRadius: 8, padding: "8px 12px", marginBottom: 12,
        }}>{failure}</div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <Tile label="Need a person" value={data?.needingAttention} colour="#dc2626" />
        <Tile label="Working" value={data?.byState?.healthy} colour="#16a34a" />
        <Tile label="Stopped" value={data?.byState?.stale_stopped} colour="#dc2626" />
        <Tile label="Not reported yet" value={data?.byState?.cannot_determine} colour="#64748b" />
        <Tile label="Components" value={components.length} />
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        “Not reported” means nothing has recorded a pass for it yet — normal for the
        first half hour after a deploy, and worth asking about a day later. It is
        never the same as “working”.
      </p>

      {groups.map((g) => {
        const rows = sorted.filter((c) => c.group === g);
        if (!rows.length) return null;
        return (
          <section key={g} style={{ marginBottom: 18 }}>
            <h4 style={{ margin: "0 0 8px" }}>{GROUP_LABEL[g] || g}</h4>
            {rows.map((row) => <Row key={row.component} row={row} />)}
          </section>
        );
      })}
    </div>
  );
}
