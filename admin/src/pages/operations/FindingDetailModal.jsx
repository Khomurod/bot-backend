import React from "react";

import {
  SEVERITY_META, TIER_META, checkLabel, changeRows, changeContext,
  confidenceLabel, formatWhen, initiatorLabel,
} from "./labels";

/**
 * One finding, with everything needed to decide about it.
 *
 * The order is the argument: what we think is wrong, WHY we think so, what
 * would change, and only then the buttons. A page that leads with an "Apply"
 * button and hides the evidence behind a disclosure triangle is asking an
 * operator to trust software about their drivers, which is precisely the habit
 * this whole feature exists to avoid.
 *
 * The proposed change is always rendered as explicit before → after rows. Never
 * "this will fix the cycle": the operator sees `return_to_road_at: — → 2026-08-31`
 * and can disagree with it.
 */

function EvidenceTable({ evidence }) {
  const entries = evidence && typeof evidence === "object" ? Object.entries(evidence) : [];
  if (!entries.length) {
    return <div className="home-time-empty-box">This finding recorded no evidence.</div>;
  }
  return (
    <div className="table-container">
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
              <td style={{ padding: "6px 8px", color: "#94a3b8", width: 180 }}>{key}</td>
              <td style={{ padding: "6px 8px" }}>
                <code>
                  {value === null || value === undefined
                    ? "—"
                    : (typeof value === "object" ? JSON.stringify(value) : String(value))}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProposedChange({ finding }) {
  const rows = changeRows(finding.proposedChange);
  const context = changeContext(finding.proposedChange);

  if (!rows.length) {
    return (
      <div className="home-time-empty-box">
        Nothing is proposed — this finding is here to be read, not acted on.
      </div>
    );
  }
  return (
    <>
      <div className="table-container">
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <tbody>
            <tr style={{ color: "#94a3b8" }}>
              <td style={{ padding: "4px 8px" }}>Field</td>
              <td style={{ padding: "4px 8px" }}>Now</td>
              <td style={{ padding: "4px 8px" }}>Would become</td>
            </tr>
            {rows.map((row) => (
              <tr key={row.field} style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
                <td style={{ padding: "6px 8px" }}><code>{row.field}</code></td>
                <td style={{ padding: "6px 8px", color: "#94a3b8" }}>{row.from}</td>
                <td style={{ padding: "6px 8px", color: "#22c55e" }}>{row.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {context.length > 0 && (
        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>
          {context.map((c) => `${c.field}: ${c.value}`).join(" · ")}
        </div>
      )}
    </>
  );
}

function PriorCorrections({ corrections }) {
  if (!corrections?.length) return null;
  return (
    <div className="home-time-section">
      <div className="home-time-section-head">
        <h4>Already done about this</h4>
      </div>
      <ul style={{ fontSize: 12, paddingLeft: 18, margin: 0 }}>
        {corrections.map((c) => (
          <li key={c.id} style={{ marginBottom: 4 }}>
            {formatWhen(c.appliedAt)} — {initiatorLabel(c.initiator)}
            {c.revertedAt ? ` · reverted ${formatWhen(c.revertedAt)} by ${c.revertedBy}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function FindingDetailModal({
  detail, busy, closeFinding, applyFinding, dismissFinding, snoozeFinding,
}) {
  const [reason, setReason] = React.useState("");
  const finding = detail?.finding;

  if (!finding) {
    return (
      <div className="home-time-modal-backdrop" onClick={closeFinding}>
        <div className="card home-time-modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="loading"><div className="spinner" /> Loading…</div>
        </div>
      </div>
    );
  }

  const severity = SEVERITY_META[finding.severity] || SEVERITY_META.info;
  const tier = TIER_META[finding.tier] || TIER_META.warning;
  const confidence = confidenceLabel(finding.confidence);
  const canApply = finding.actionable && finding.tier === "auto" && finding.status === "open";

  return (
    <div className="home-time-modal-backdrop" onClick={closeFinding}>
      <div className="card home-time-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="home-time-modal-header">
          <div>
            <div className="home-time-modal-kicker">{checkLabel(finding.checkKey)}</div>
            <h3>{finding.title}</h3>
            <p>
              <span className={`status-pill ${severity.pill}`}>{severity.label}</span>{" "}
              <span className={`status-pill ${tier.pill}`}>{tier.label}</span>{" "}
              {confidence && <span className="badge badge-muted">{confidence}</span>}
            </p>
          </div>
          <button
            type="button"
            className="home-time-modal-close"
            aria-label="Close finding details"
            onClick={closeFinding}
          >
            ×
          </button>
        </div>

        <div className="home-time-modal-body">
          <div className="home-time-section">
            <div className="home-time-section-head">
              <h4>What this means</h4>
              <p>{tier.hint}</p>
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8" }}>
              First seen {formatWhen(finding.firstSeenAt)} · still true as of{" "}
              {formatWhen(finding.lastSeenAt)}
              {finding.status !== "open" && ` · ${finding.status}`}
            </div>
            {finding.dismissReason && (
              <div style={{ fontSize: 12, marginTop: 6 }}>
                Dismissed by {finding.dismissedBy || "someone"}: “{finding.dismissReason}”
              </div>
            )}
          </div>

          <div className="home-time-section">
            <div className="home-time-section-head">
              <h4>Why we think so</h4>
              <p>The exact values this was built from. Nothing here is inferred.</p>
            </div>
            <EvidenceTable evidence={finding.evidence} />
          </div>

          <div className="home-time-section">
            <div className="home-time-section-head">
              <h4>What would change</h4>
            </div>
            <ProposedChange finding={finding} />
          </div>

          <PriorCorrections corrections={detail.corrections} />

          {finding.status === "open" && (
            <div className="home-time-section">
              <div className="home-time-section-head">
                <h4>Decide</h4>
                <p>
                  A dismissal needs a reason — it is what tells the next person why
                  this was left alone, and a dismissed finding stays dismissed even
                  while the condition holds.
                </p>
              </div>
              <div className="form-group">
                <textarea
                  className="form-textarea"
                  rows={2}
                  value={reason}
                  placeholder="Reason (required to dismiss, optional otherwise)"
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {canApply && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => applyFinding(finding.id, reason.trim() || null)}
                  >
                    Apply the correction
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy || !reason.trim()}
                  title={reason.trim() ? "" : "A dismissal needs a reason"}
                  onClick={() => dismissFinding(finding.id, reason.trim())}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => snoozeFinding(finding.id, 24 * 7)}
                >
                  Snooze a week
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
