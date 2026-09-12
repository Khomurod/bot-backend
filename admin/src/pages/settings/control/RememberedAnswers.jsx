import React from "react";

/**
 * What Wenze is currently not asking about, and why.
 *
 * THE SENTENCE THIS LIST HAS TO GET RIGHT is "while nothing changes". A person
 * looking at "Wenze stopped asking about unit 310" needs to know it is not the
 * same as switching the check off: the answer is attached to that situation,
 * and a different one is asked about again. Without that, this list reads as a
 * pile of silenced alarms and somebody sensibly clears it.
 *
 * It shows the owner's own words. It shows no ids: which driver is named in the
 * question, and the question is where it belongs.
 */
function describe(memory) {
  if (memory.answerAction === "dismiss") return "No";
  if (memory.answerAction === "snooze") return "Later";
  return "Yes";
}

export default function RememberedAnswers({ memories = [], busy, onForget }) {
  if (!memories.length) {
    return (
      <div className="muted" style={{ fontSize: 12, marginTop: 14 }}>
        Nothing is being remembered yet. When you answer a question with a reason, Wenze
        keeps that answer and stops asking — until the situation changes.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 18 }}>
      <h4 style={{ margin: "0 0 4px" }}>Answers Wenze is remembering</h4>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Each of these stops one question coming back — but only while that situation stays
        as it is. A new problem about the same driver is still asked about. A remembered
        <em> yes</em> is kept as a record and is never applied on its own.
      </div>
      <table className="table" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th>About</th>
            <th>You said</th>
            <th>Used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {memories.map((m) => (
            <tr key={m.id}>
              <td>{m.checkKey.replace(/[._]/g, " ")}</td>
              <td>
                <strong>{describe(m)}</strong>
                {m.answerText ? ` — “${m.answerText}”` : ""}
              </td>
              <td>{m.timesApplied}</td>
              <td>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => onForget(m.id)}
                >
                  Forget
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
