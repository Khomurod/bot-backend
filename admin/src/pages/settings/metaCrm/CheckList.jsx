import React from "react";

/**
 * The four Test checks, each pass / warning / fail / not run with its
 * plain-words explanation, Meta's own words under any answer that was not a
 * plain yes, and the dry run's numbers and example deals. A warning does not
 * block Save (services/metaCrm/settingsRules.js testPassed).
 */

const BADGE = {
  pass: { text: "✓ Pass", className: "badge badge-active" },
  warn: { text: "! Warning", className: "badge badge-warning" },
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

function headline(result) {
  if (!result.passed) return "❌ Test did not pass — fix what failed and test again.";
  if (result.checks.some((c) => c.status === "warn")) return "⚠️ Test passed with a warning — read it below; you can still save these values.";
  return "✅ Test passed — you can save these values.";
}

export default function CheckList({ result }) {
  if (!result) return null;
  return (
    <div style={{ marginTop: 14 }} data-testid="meta-crm-checks">
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        {headline(result)}
        {result.usedStoredToken && (
          <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-muted)" }}> (tested with the token already in use)</span>
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
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>Meta said: {c.detail.metaError}</div>
            )}
            {c.key === "dry_run" && <DryRunDetail detail={c.detail} />}
          </div>
        );
      })}
    </div>
  );
}
