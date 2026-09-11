import React from "react";

import * as api from "../../api";

/**
 * Who the company may be about to lose, and what to do about it today.
 *
 * WHAT THIS SCREEN DELIBERATELY IS NOT is more important than what it is. Every
 * reason shown is something the COMPANY did — a home window promised and
 * missed, a bonus earned and unpaid, weeks past the allowance — or something
 * the driver said in their own words. There is no field to record an opinion of
 * a driver, no score of their performance, and no button that does anything to
 * their employment. A screen with any of those would, within a month, be a
 * performance file nobody agreed to.
 *
 * So the strongest element on the row is the SUGGESTED ACTION, and every one of
 * them is a thing a person does: ring them, answer the request, pay the bonus,
 * find them a load.
 */
const LEVEL = {
  urgent: { label: "Urgent", colour: "#dc2626", tint: "rgba(220,38,38,0.10)" },
  watch: { label: "Watch", colour: "#d97706", tint: "rgba(217,119,6,0.10)" },
};

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

function Row({ row, onAcknowledge, busy }) {
  const level = LEVEL[row.level] || LEVEL.watch;
  return (
    <div style={{
      border: "1px solid rgba(148,163,184,0.25)",
      borderLeft: `3px solid ${level.colour}`,
      background: row.acknowledgedAt ? "transparent" : level.tint,
      borderRadius: 8, padding: "10px 12px", marginBottom: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 340px", minWidth: 0 }}>
          <strong>{row.driverName || `Group ${row.groupId}`}</strong>{" "}
          <span className="muted" style={{ fontSize: 12 }}>· {level.label}</span>

          {/* The reasons, in the order they weigh. Not a score — a score alone
              tells a dispatcher nothing they can act on. */}
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {(row.signals || []).map((s) => (
              <li key={s.key} style={{ fontSize: 13 }}>{s.detail}</li>
            ))}
          </ul>

          {(row.actions || []).length > 0 && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              {row.actions.map((a) => (
                <div key={a}><strong>→ {a}</strong></div>
              ))}
            </div>
          )}

          {row.acknowledgedAt && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Acknowledged{row.acknowledgedBy ? ` by ${row.acknowledgedBy}` : ""} — Wenze will stay
              quiet about this until it gets worse.
            </div>
          )}
        </div>
        <div>
          <button
            type="button" className="btn btn-sm" disabled={busy}
            onClick={() => onAcknowledge(row, !row.acknowledgedAt)}
          >
            {row.acknowledgedAt ? "Un-acknowledge" : "We know"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RetentionTab({ flash }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getRetention());
    } catch (err) {
      flash?.("error", err.message || "Could not load the retention list");
    } finally {
      setLoading(false);
    }
  }, [flash]);

  React.useEffect(() => { load(); }, [load]);

  const acknowledge = async (row, next) => {
    setBusy(true);
    try {
      await api.acknowledgeRetention(row.id, next);
      await load();
    } catch (err) {
      flash?.("error", err.message || "Could not update");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card"><p className="muted">Loading…</p></div>;
  if (!data) return null;

  const { assessments = [], summary = {} } = data;

  return (
    <div className="card">
      <h3>Drivers who may be about to leave</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Every reason below is something the company did, or something the driver said. Nothing
        here is a judgement about how somebody does their job, and no action on this page
        changes anybody's employment.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "12px 0" }}>
        <Tile label="Urgent" value={summary.urgent} colour={LEVEL.urgent.colour} />
        <Tile label="Worth watching" value={summary.watch} colour={LEVEL.watch.colour} />
        <Tile label="Acknowledged" value={summary.acknowledged} />
      </div>

      {assessments.length === 0 && (
        <p className="muted">Nobody is flagged. Wenze checks every four hours.</p>
      )}
      {assessments.map((row) => (
        <Row key={row.id} row={row} onAcknowledge={acknowledge} busy={busy} />
      ))}
    </div>
  );
}
