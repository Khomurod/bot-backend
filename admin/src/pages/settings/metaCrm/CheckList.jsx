import React from "react";

/**
 * The four Test checks, each pass / fail / not run with its plain-words
 * explanation, Meta's own error under a failed one, and the dry run's numbers
 * and example deals.
 */

const BADGE = {
  pass: { text: "✓ Pass", className: "badge badge-active" },
  fail: { text: "✕ Fail", className: "badge badge-inactive" },
  not_run: { text: "— Not run", className: "badge badge-muted" },
};

function DryRunDetail({ detail }) {
  if (!detail || !Array.isArray(detail.examples) || detail.examples.length === 0) return null;
  return (
    <table style={{ marginTop: 6, fontSize: 12, borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={{ textAlign: "left", paddingRight: 16 }}>Deal</th>
          <th style={{ textAlign: "left", paddingRight: 16 }}>Stage</th>
          <th style={{ textAlign: "left" }}>Would send</th>
        </tr>
      </thead>
      <tbody>
        {detail.examples.map((row) => (
          <tr key={`${row.dealId}-${row.eventName}`}>
            <td style={{ paddingRight: 16 }}>{row.dealId}</td>
            <td style={{ paddingRight: 16 }}>{row.stageId}</td>
            <td>{row.eventName}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function CheckList({ result }) {
  if (!result) return null;
  return (
    <div style={{ marginTop: 14 }} data-testid="meta-crm-checks">
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        {result.passed ? "✅ Test passed — you can save these values." : "❌ Test did not pass — fix what failed and test again."}
        {result.usedStoredToken && (
          <span style={{ fontWeight: 400, fontSize: 12, color: "#94a3b8" }}> (tested with the token already in use)</span>
        )}
      </div>
      {result.checks.map((c) => {
        const badge = BADGE[c.status] || BADGE.not_run;
        return (
          <div key={c.key} className="card" style={{ padding: 10, marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className={badge.className}>{badge.text}</span>
              <strong>{c.label}</strong>
            </div>
            <div style={{ fontSize: 13, marginTop: 4 }}>{c.message}</div>
            {c.detail?.metaError && (
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>Meta said: {c.detail.metaError}</div>
            )}
            {c.key === "dry_run" && <DryRunDetail detail={c.detail} />}
          </div>
        );
      })}
    </div>
  );
}
