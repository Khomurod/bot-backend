import React from "react";

import * as api from "../../api";

/**
 * Things somebody asked Wenze for that only a person can build.
 *
 * WHY THIS SCREEN EXISTS AT ALL. The owner can answer a question in Telegram by
 * saying the question itself is wrong — "this is a bug", "stop asking me this",
 * "the truck numbers come from the wrong place". That is the most valuable
 * thing anybody ever says to this application and it was the one reply it
 * dropped: acknowledged politely, and forgotten. Now it becomes a row, and this
 * is where a person reads it.
 *
 * WHAT THE SCREEN DELIBERATELY CANNOT DO. There is no button that acts on a
 * request. Nothing here runs, builds, fetches or applies anything — the
 * reference field is a sentence somebody types so the next person can find the
 * work, and the application never reads it back. The bot does not edit its own
 * source, and the shortest way to keep that true is to give this page no way to.
 */
const STATUS = {
  open: { label: "Waiting", colour: "#eab308" },
  accepted: { label: "Accepted", colour: "#0891b2" },
  in_progress: { label: "Being built", colour: "#0891b2" },
  done: { label: "Done", colour: "#16a34a" },
  declined: { label: "Not doing it", colour: "#64748b" },
};

function Request({ row, onDecide, busy }) {
  const [reference, setReference] = React.useState(row.linkedReference || "");
  const [note, setNote] = React.useState("");
  const state = STATUS[row.status] || STATUS.open;

  return (
    <div className="home-time-section" style={{ marginBottom: 12 }}>
      <div className="home-time-section-head">
        <h4 style={{ margin: 0 }}>
          Request #{row.id}{" "}
          <span style={{ color: state.colour, fontSize: 12 }}>· {state.label}</span>
        </h4>
        <p style={{ margin: "4px 0 0" }}>
          Asked {row.requestedBy?.startsWith("telegram:") ? "in Telegram" : "in the admin"}
          {row.waitingDays ? ` · waiting ${row.waitingDays} days` : ""}
        </p>
      </div>

      {/* THEIR WORDS, NOT A SUMMARY. A restatement is somebody else's reading. */}
      <blockquote style={{ margin: "8px 0", fontSize: 13, borderLeft: "3px solid #cbd5e1", paddingLeft: 10 }}>
        {row.requestText}
      </blockquote>

      {row.status === "open" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 220px" }}>
            <div style={{ fontSize: 12 }}>Where the work is (optional)</div>
            <input
              type="text"
              value={reference}
              placeholder="e.g. PR #231"
              disabled={busy}
              onChange={(e) => setReference(e.target.value)}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ flex: "1 1 220px" }}>
            <div style={{ fontSize: 12 }}>Note (optional)</div>
            <input
              type="text"
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
              style={{ width: "100%" }}
            />
          </label>
          <button type="button" className="btn btn-primary" disabled={busy}
            onClick={() => onDecide(row.id, { status: "accepted", linkedReference: reference, decisionNote: note })}>
            Accept
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy}
            onClick={() => onDecide(row.id, { status: "done", linkedReference: reference, decisionNote: note })}>
            Mark done
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy}
            onClick={() => onDecide(row.id, { status: "declined", decisionNote: note })}>
            Not doing it
          </button>
        </div>
      )}

      {row.status !== "open" && row.linkedReference && (
        <div className="muted" style={{ fontSize: 12 }}>Where the work is: {row.linkedReference}</div>
      )}
      {row.decisionNote && (
        <div className="muted" style={{ fontSize: 12 }}>{row.decisionNote}</div>
      )}
    </div>
  );
}

export default function EngineeringRequestsCard({ flash }) {
  const [state, setState] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      setState(await api.getEngineeringRequests());
      setError(null);
    } catch (err) {
      setError(err.message || "Could not load what has been asked for.");
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const decide = async (id, payload) => {
    setBusy(true);
    try {
      await api.decideEngineeringRequest(id, payload);
      await load();
      flash?.("success", "Recorded.");
    } catch (err) {
      flash?.("error", err.message || "Could not record that.");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="card"><div className="muted">{error}</div></div>;
  if (!state) return <div className="card"><div className="muted">Loading…</div></div>;

  const { requests = [], summary = {} } = state;
  const open = requests.filter((r) => r.status === "open");

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Things a person has to build</h3>
      <div className="muted" style={{ marginBottom: 12 }}>
        When you answer a question in Telegram by saying the question itself is wrong, it is
        recorded here. Wenze never changes its own code — somebody reads this and does the work.
      </div>

      {!requests.length && (
        <div className="muted" style={{ fontSize: 12 }}>
          Nothing has been asked for yet.
        </div>
      )}

      {open.map((row) => (
        <Request key={row.id} row={row} onDecide={decide} busy={busy} />
      ))}

      {summary.available && (summary.done || summary.declined || summary.taken) ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {summary.taken} being worked on · {summary.done} done · {summary.declined} declined
        </div>
      ) : null}
    </div>
  );
}
