import React, { useState } from "react";
import { Modal } from "./TrailerUi";

/**
 * The 1-minute guide (blocker §12): a short, dismissible walk-through of the
 * five things a first-time office employee needs — Home, starting a rental,
 * confirming pickup, returning a trailer, recording payment. It EXPLAINS each
 * step; it does not merely open the rental wizard.
 */
export default function HomeGuide({ steps, onClose }) {
  const [i, setI] = useState(0);
  const step = steps[i];
  const last = i === steps.length - 1;

  return (
    <Modal title="1-minute guide" subtitle={`Step ${i + 1} of ${steps.length}`} onClose={onClose}>
      <div role="group" aria-label={`Guide step ${i + 1}: ${step.title}`}>
        <h3 style={{ marginTop: 0 }}>{step.title}</h3>
        <p>{step.body}</p>
      </div>
      <ol className="trailer-guide-dots" aria-hidden="true" style={{ display: "flex", gap: 6, listStyle: "none", padding: 0 }}>
        {steps.map((s, idx) => (
          <li key={s.title}
            style={{
              width: 8, height: 8, borderRadius: "50%",
              background: idx === i ? "#2563eb" : "#cbd5e1",
            }} />
        ))}
      </ol>
      <div className="trailer-actions" style={{ marginTop: 16 }}>
        {i > 0 && (
          <button type="button" className="btn btn-secondary" onClick={() => setI(i - 1)}>Back</button>
        )}
        {!last && (
          <button type="button" className="btn btn-primary" onClick={() => setI(i + 1)}>Next</button>
        )}
        {last && (
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        )}
      </div>
    </Modal>
  );
}
