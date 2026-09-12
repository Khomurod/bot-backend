import React from "react";

import * as api from "../../api";
import EngineeringRequestsCard from "./EngineeringRequestsCard";

/**
 * What Wenze has noticed about its own mistakes.
 *
 * THE SCREEN'S JOB IS TO MAKE TWO THINGS IMPOSSIBLE TO CONFUSE. Some
 * suggestions name a setting, and accepting one changes it — visibly, with an
 * undo. Most do not, and accepting one of those records agreement and nothing
 * else, because what a company offers a driver is a fact a PERSON supplies.
 *
 * They used to look identical: everything read "You agreed" and nothing ever
 * changed. Somebody who accepted "switch automatic correction off for this
 * check" reasonably believed they had switched it off. That is worse than not
 * offering the button, because it produces false confidence rather than an
 * obvious gap.
 *
 * So the button says which it is BEFORE it is pressed, and the row says which
 * it was afterwards. `Active` rows carry Undo; `Needs you to do it` rows carry
 * a plain statement that nothing changed.
 *
 * The evidence is shown beside every proposal because a suggestion without it
 * is an opinion. "This was undone three times, and here are the reasons the
 * people gave" is something to judge; "Wenze thinks this check is wrong" is not.
 */
const KIND_LABEL = {
  reverted_correction: "A correction that keeps being undone",
  recruiting_refusal: "Answers to candidates that keep being refused",
  contradicted_decisions: "A check whose decisions keep not holding up",
  repeated_owner_answer: "Something you keep answering the same way",
};

const STATUS = {
  proposed: { label: "Waiting for you", colour: "#eab308" },
  // FIVE STATES, and the middle two are the whole point of this screen.
  accepted_active: { label: "Agreed — and the setting is changed", colour: "#16a34a" },
  accepted_manual: { label: "Agreed — needs you to do it", colour: "#0891b2" },
  // Rows decided before anything could be applied. They are agreements and
  // nothing more; relabelling them would invent a history they do not have.
  accepted: { label: "Agreed (before Wenze could apply anything)", colour: "#64748b" },
  dismissed: { label: "You said no", colour: "#64748b" },
  reverted: { label: "Undone", colour: "#64748b" },
};

function Suggestion({ row, onDecide, onAccept, onRevert, busy }) {
  const [note, setNote] = React.useState("");
  const waiting = row.status === "proposed";
  const state = STATUS[row.status] || STATUS.proposed;
  // Whether accepting THIS one would change anything. Read off the row rather
  // than assumed, so the button cannot promise more than the server will do.
  const willChange = Boolean(row.applyAction);
  const isActive = row.status === "accepted_active";

  return (
    <div style={{
      border: "1px solid rgba(148,163,184,0.25)",
      borderLeft: `3px solid ${state.colour}`,
      borderRadius: 8, padding: "10px 12px", marginBottom: 8,
    }}>
      <div><strong>{row.title}</strong></div>
      <div style={{ fontSize: 12, marginTop: 2 }}>
        <span className="muted">{KIND_LABEL[row.kind] || row.kind} · </span>
        <span style={{ color: state.colour }}>{state.label}</span>
        {row.decidedBy && <span className="muted"> · {row.decidedBy}</span>}
        {row.decisionNote && <span className="muted"> — “{row.decisionNote}”</span>}
      </div>

      <div style={{ marginTop: 6, fontSize: 13 }}>{row.suggestion}</div>

      {row.evidence?.reasons?.length > 0 && (
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          Reasons people gave: {row.evidence.reasons.join("; ")}
        </div>
      )}

      {/* WHAT THE BUTTON WILL DO, before it is pressed. */}
      {waiting && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {willChange
            ? "Agreeing will switch this setting now. One click puts it back."
            : "Agreeing records that you agree. Nothing changes automatically — "
              + "this one is for a person to carry out."}
        </div>
      )}

      {waiting && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text" placeholder="a note, if you want one" value={note}
            onChange={(e) => setNote(e.target.value)} style={{ flex: "1 1 200px" }}
          />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy}
            onClick={() => onAccept(row, note)}
            title={willChange
              ? "Switches the setting now, and records what it was."
              : "Records that you agree. Nothing changes automatically."}>
            {willChange ? "Agree and apply" : "Agree"}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy}
            onClick={() => onDecide(row, "dismissed", note)}>
            No
          </button>
        </div>
      )}

      {isActive && (
        <button type="button" className="btn btn-sm" disabled={busy}
          style={{ marginTop: 8 }} onClick={() => onRevert(row)}>
          Undo the change
        </button>
      )}
      {!waiting && !isActive && (
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

  // The server decides whether anything changed; the message repeats what it
  // says rather than what the screen assumed. A UI that guessed would be the
  // same defect one layer up.
  const accept = async (row, note) => {
    setBusy(true);
    try {
      const out = await api.acceptLearningSuggestion(row.id, note || null);
      flash?.(out.applied ? "success" : "info", out.detail);
      await load();
    } catch (err) {
      flash?.("error", err.message || "Could not accept that");
    } finally {
      setBusy(false);
    }
  };

  const revert = async (row) => {
    setBusy(true);
    try {
      const out = await api.revertLearningSuggestion(row.id, null);
      flash?.(out.reverted ? "success" : "info", out.detail);
      await load();
    } catch (err) {
      flash?.("error", err.message || "Could not undo that");
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
        a candidate is refused several times, Wenze says so. <strong>Some suggestions name a
        setting, and agreeing switches it — with an undo. Most do not, and agreeing records
        that you agree and nothing more.</strong> Each one says which, before you press
        anything. Nothing is ever changed without you.
      </p>

      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        {summary.proposed ?? 0} waiting · {summary.accepted ?? 0} agreed · {summary.dismissed ?? 0} declined
      </div>

      {suggestions.length === 0 && (
        <p className="muted">Nothing suggested. Wenze looks twice a day.</p>
      )}
      {suggestions.map((row) => (
        <Suggestion
          key={row.id} row={row} onDecide={decide} onAccept={accept} onRevert={revert}
          busy={busy}
        />
      ))}

      {/* THE OTHER HALF OF LEARNING, and the one nothing in this application can
          act on. A suggestion about a setting has a button; a request to change
          the software has a person. They belong on the same screen because they
          arrive from the same place — somebody saying Wenze got it wrong. */}
      <EngineeringRequestsCard flash={flash} />
    </div>
  );
}
