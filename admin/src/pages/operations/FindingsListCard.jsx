import React from "react";

import { SEVERITY_META, TIER_META, groupByCheck, formatAgo } from "./labels";

/**
 * The findings list, grouped by check.
 *
 * Grouping is the whole design. Forty-six drivers past their road allowance is
 * ONE thing an operator needs to think about, and forty-six rows in a flat list
 * is a page nobody opens twice. Each group collapses to a headline with a count
 * and expands to its subjects.
 *
 * `severity` decides order, not recency: a serious finding filed last week
 * outranks an informational one from this morning.
 */

function SeverityTiles({ summary }) {
  // Zero-filled from the server; rendered unconditionally for the same reason.
  // A tile that vanishes at zero reads as "this feature is broken", and an
  // operator cannot tell that apart from "there is nothing to report".
  const counts = summary?.findings || { serious: 0, warning: 0, info: 0, total: 0 };
  return (
    <div className="stats-grid" style={{ marginBottom: 16 }}>
      {["serious", "warning", "info"].map((key) => (
        <div className="stat-card" key={key}>
          <div className="stat-value">{counts[key] ?? 0}</div>
          <div className="stat-label">{SEVERITY_META[key].label}</div>
        </div>
      ))}
      <div className="stat-card">
        <div className="stat-value">{summary?.corrections?.live ?? 0}</div>
        <div className="stat-label">Corrections in effect</div>
      </div>
    </div>
  );
}

function GroupRow({ group, expanded, onToggle, onOpen }) {
  const meta = SEVERITY_META[group.severity] || SEVERITY_META.info;
  return (
    <>
      <tr style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
        <td style={{ padding: "10px 8px" }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            {expanded ? "▾" : "▸"} {group.label}
          </button>
        </td>
        <td style={{ padding: "10px 8px", width: 110 }}>
          <span className={`status-pill ${meta.pill}`}>{meta.label}</span>
        </td>
        <td style={{ padding: "10px 8px", width: 90, textAlign: "right" }}>
          <strong>{group.items.length}</strong>
        </td>
      </tr>
      {expanded && group.items.map((finding) => (
        <tr key={finding.id} style={{ borderTop: "1px solid rgba(148,163,184,0.08)" }}>
          <td style={{ padding: "6px 8px 6px 28px", fontSize: 13 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onOpen(finding.id)}
              style={{ textAlign: "left" }}
            >
              {finding.title}
            </button>
            <div style={{ color: "#94a3b8", fontSize: 11, paddingLeft: 8 }}>
              first seen {formatAgo(finding.firstSeenAt)}
              {finding.status !== "open" ? ` · ${finding.status}` : ""}
              {finding.snoozedUntil ? " · snoozed" : ""}
            </div>
          </td>
          <td colSpan={2} style={{ padding: "6px 8px", fontSize: 11, color: "#94a3b8" }}>
            {(TIER_META[finding.tier] || TIER_META.warning).label}
          </td>
        </tr>
      ))}
    </>
  );
}

export default function FindingsListCard({
  summary, findings, loading, sweeping, runSweep,
  includeDismissed, setIncludeDismissed, openFinding,
}) {
  const [expanded, setExpanded] = React.useState(() => new Set());
  const groups = React.useMemo(() => groupByCheck(findings), [findings]);

  const toggle = (checkKey) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(checkKey)) next.delete(checkKey); else next.add(checkKey);
    return next;
  });

  return (
    <>
      <SeverityTiles summary={summary} />

      <div className="card">
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, flexWrap: "wrap", marginBottom: 8,
        }}
        >
          <div>
            <strong>Findings</strong>
            {/* Why the sweep line is here: an empty page and a stopped sweep look
                identical, and mean opposite things. */}
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              {summary?.sweep?.running === false
                ? "The consistency sweep is not running."
                : `Checks last ran ${formatAgo(summary?.sweep?.lastRun?.at)}.`}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 6 }}>
              <input
                type="checkbox"
                checked={includeDismissed}
                onChange={(e) => setIncludeDismissed(e.target.checked)}
              />
              Include dismissed and snoozed
            </label>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={runSweep}
              disabled={sweeping}
            >
              {sweeping ? "Re-running…" : "Run checks now"}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="loading"><div className="spinner" /> Loading findings…</div>
        ) : groups.length === 0 ? (
          <div className="empty-state">
            <div className="icon">✅</div>
            <h3>Nothing needs attention</h3>
            <p>
              Every check the system runs agrees with itself right now.
            </p>
          </div>
        ) : (
          <div className="table-container">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {groups.map((group) => (
                  <GroupRow
                    key={group.checkKey}
                    group={group}
                    expanded={expanded.has(group.checkKey)}
                    onToggle={() => toggle(group.checkKey)}
                    onOpen={openFinding}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
