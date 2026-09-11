import React from "react";

import * as api from "../../api";

/**
 * What Wenze has noticed about its own mistakes.
 *
 * ACCEPTING A SUGGESTION CHANGES NOTHING BY ITSELF, and the screen says so in
 * as many words. It records that an administrator agrees; the change is then
 * made by hand, on purpose. A button that both proposed and applied would make
 * the confirmation a formality one careless click wide, and the owner's line is
 * that important business rules must not change permanently without somebody
 * confirming.
 *
 * The evidence is shown beside every proposal because a suggestion without it
 * is an opinion. "This was undone three times, and here are the reasons the
 * people gave" is something to judge; "Wenze thinks this check is wrong" is not.
 */
const KIND_LABEL = {
  reverted_correction: "A correction that keeps being undone",
  recruiting_refusal: "Answers to candidates that keep being refused",
};

const STATUS_LABEL = {
  proposed: "Waiting for you",
  accepted: "You agreed",
  dismissed: "You said no",
};

function Suggestion({ row, onDecide, busy }) {
  const [note, setNote] = React.useState("");
  const waiting = row.status === "proposed";
  return (
    <div style={{
      border: "1px solid rgba(148,163,184,0.25)",
      borderLeft: waiting ? "3px solid #eab308" : "1px solid rgba(148,163,184,0.25)",
      borderRadius: 8, padding: "10px 12px", marginBottom: 8,
    }}>
      <div><strong>{row.title}</strong></div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        {KIND_LABEL[row.kind] || row.kind} · {STATUS_LABEL[row.status] || row.status}
        {row.decidedBy && ` · ${row.decidedBy}`}
        {row.decisionNote && ` — "${row.decisionNote}"`}
      </div>

      <div style={{ marginTop: 6, fontSize: 13 }}>{row.suggestion}</div>

      {row.evidence?.reasons?.length > 0 && (
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          Reasons people gave: {row.evidence.reasons.join("; ")}
        </div>
      )}

      {waiting && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text" placeholder="a note, if you want one" value={note}
            onChange={(e) => setNote(e.target.value)} style={{ flex: "1 1 200px" }}
          />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy}
            onClick={() => onDecide(row, "accepted", note)}
            title="Records that you agree. It does not change anything on its own.">
            Good idea
          </button>
          <button type="button" className="btn btn-sm" disabled={busy}
            onClick={() => onDecide(row, "dismissed", note)}>
            No
          </button>
        </div>
      )}
      {!waiting && (
        <button type="button" className="btn btn-sm" disabled={busy}
          style={{ marginTop: 8 }} onClick={() => onDecide(row, "proposed", null)}>
          Undo that decision
        </button>
      )}
    </div>
  );
}

export default function LearningTab({ flash }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getLearningSuggestions());
    } catch (err) {
      flash?.("error", err.message || "Could not load the suggestions");
    } finally {
      setLoading(false);
    }
  }, [flash]);

  React.useEffect(() => { load(); }, [load]);

  const decide = async (row, status, note) => {
    setBusy(true);
    try {
      await api.decideLearningSuggestion(row.id, status, note || null);
      await load();
    } catch (err) {
      flash?.("error", err.message || "Could not record that");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card"><p className="muted">Loading…</p></div>;
  if (!data) return null;

  const { suggestions = [], summary = {} } = data;

  return (
    <div className="card">
      <h3>What Wenze has noticed about its own mistakes</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        When the same automatic correction is undone several times, or the same kind of answer to
        a candidate is refused several times, Wenze says so. <strong>Agreeing records that you
        agree — it does not change anything on its own.</strong> Whatever the suggestion proposes
        is still done by hand.
      </p>

      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        {summary.proposed ?? 0} waiting · {summary.accepted ?? 0} agreed · {summary.dismissed ?? 0} declined
      </div>

      {suggestions.length === 0 && (
        <p className="muted">Nothing suggested. Wenze looks twice a day.</p>
      )}
      {suggestions.map((row) => (
        <Suggestion key={row.id} row={row} onDecide={decide} busy={busy} />
      ))}
    </div>
  );
}
