/**
 * Admin — one submission in full: every question the employee received, the
 * selected option with its scoring meaning (pattern + weight), the score
 * breakdown, and the personal result text they saw.
 */
import { PatternChip, PATTERN_COLORS } from "./SosSubmissionsTable";

const PATTERN_ORDER = ["victim", "complaint", "waiting", "blame", "ownership", "builder"];

export default function SosSubmissionDetail({ detail, departmentLabels, onClose, onDelete }) {
  const maxScore = Math.max(1, ...PATTERN_ORDER.map((p) => detail.patternScores?.[p] || 0));

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(2,6,23,0.65)", zIndex: 60,
        display: "flex", justifyContent: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(760px, 100%)", height: "100%", overflowY: "auto",
          background: "var(--bg-secondary, #151823)", padding: 24, boxShadow: "-12px 0 40px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Submission #{detail.id} — {detail.fullName}</h3>
          <button className="btn" onClick={onClose}>✕ Close</button>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 14, marginBottom: 16 }}>
          <span className="card" style={{ padding: "6px 12px" }}>{departmentLabels[detail.department] || detail.department}</span>
          {detail.dispatchTeamName && <span className="card" style={{ padding: "6px 12px" }}>🚚 {detail.dispatchTeamName}</span>}
          <span className="card" style={{ padding: "6px 12px", textTransform: "uppercase" }}>{detail.language}</span>
          <span className="card" style={{ padding: "6px 12px" }}>{new Date(detail.createdAt).toLocaleString()}</span>
          {detail.duplicateConfirmed && <span className="card" style={{ padding: "6px 12px", color: "#fab219" }}>⚠ resubmitted after duplicate warning</span>}
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h4 style={{ marginTop: 0 }}>Result</h4>
          <p style={{ margin: "4px 0" }}>Primary: <PatternChip pattern={detail.primaryPattern} /></p>
          <p style={{ margin: "4px 0 12px" }}>Secondary: <PatternChip pattern={detail.secondaryPattern} /></p>
          {PATTERN_ORDER.map((p) => (
            <div key={p} style={{ display: "grid", gridTemplateColumns: "150px 1fr 40px", gap: 10, alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 13, textAlign: "right", opacity: 0.8 }}><PatternChip pattern={p} /></span>
              <div style={{ height: 14, background: "rgba(148,163,184,0.15)", borderRadius: 5, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 4, background: PATTERN_COLORS[p],
                  width: `${((detail.patternScores?.[p] || 0) / maxScore) * 100}%`, minWidth: 2,
                }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{detail.patternScores?.[p] || 0}</span>
            </div>
          ))}
          {detail.primaryResult && (
            <p style={{ fontSize: 13.5, opacity: 0.85, marginTop: 12 }}>
              <b>{detail.primaryResult.name}:</b> {detail.primaryResult.headline}
            </p>
          )}
          {detail.secondaryResult && (
            <p style={{ fontSize: 13.5, opacity: 0.85 }}>
              <b>{detail.secondaryResult.name}:</b> {detail.secondaryResult.headline}
            </p>
          )}
        </div>

        <h4>Answers ({detail.answers.length})</h4>
        {detail.answers.map((answer) => (
          <div key={answer.questionKey} className="card" style={{ marginBottom: 10, padding: 14 }}>
            <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 4 }}>Question {answer.position}</div>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{answer.questionText}</div>
            {answer.questionTextEn !== answer.questionText && (
              <div style={{ fontSize: 12.5, opacity: 0.55, marginBottom: 8 }}>EN: {answer.questionTextEn}</div>
            )}
            <div style={{ background: "rgba(99,102,241,0.1)", borderRadius: 8, padding: "10px 12px", fontSize: 14 }}>
              <div>{answer.optionText}</div>
              {answer.optionTextEn !== answer.optionText && (
                <div style={{ fontSize: 12.5, opacity: 0.55, marginTop: 4 }}>EN: {answer.optionTextEn}</div>
              )}
              <div style={{ marginTop: 8, fontSize: 13 }}>
                Scoring meaning: <PatternChip pattern={answer.pattern} />
                <span style={{ opacity: 0.7 }}> (+{answer.weight} point{answer.weight === 1 ? "" : "s"})</span>
              </div>
            </div>
          </div>
        ))}

        <button className="btn" style={{ color: "#f87171", marginTop: 8 }} onClick={() => onDelete(detail.id)}>
          🗑 Delete this submission
        </button>
      </div>
    </div>
  );
}
