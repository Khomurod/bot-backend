/**
 * Admin — SOS submissions list: filters (department / pattern / name search),
 * duplicate badges, open-detail and delete actions.
 */
import { useState } from "react";

const PATTERN_LABELS = {
  victim: "Focus on circumstances",
  complaint: "Voicing the problem",
  waiting: "Careful waiting",
  blame: "Tracing the mistake",
  ownership: "Personal initiative",
  builder: "Builder mindset",
};

export const PATTERN_COLORS = {
  victim: "#2a78d6", complaint: "#eb6834", waiting: "#1baf7a",
  blame: "#eda100", ownership: "#e87ba4", builder: "#008300",
};

export function PatternChip({ pattern }) {
  if (!pattern) return <span style={{ opacity: 0.5 }}>—</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      <span style={{ width: 10, height: 10, borderRadius: "50%", background: PATTERN_COLORS[pattern] }} />
      {PATTERN_LABELS[pattern] || pattern}
    </span>
  );
}

export default function SosSubmissionsTable({
  rows, filters, onFiltersChange, onOpenDetail, onDelete, departmentLabels, busy,
}) {
  const [search, setSearch] = useState(filters.search);

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <select
          className="form-input"
          style={{ maxWidth: 220 }}
          value={filters.department}
          onChange={(e) => onFiltersChange({ ...filters, department: e.target.value })}
        >
          <option value="">All departments</option>
          {Object.entries(departmentLabels).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <select
          className="form-input"
          style={{ maxWidth: 240 }}
          value={filters.pattern}
          onChange={(e) => onFiltersChange({ ...filters, pattern: e.target.value })}
        >
          <option value="">All result patterns</option>
          {Object.entries(PATTERN_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <form
          style={{ display: "flex", gap: 8 }}
          onSubmit={(e) => { e.preventDefault(); onFiltersChange({ ...filters, search }); }}
        >
          <input
            className="form-input"
            style={{ maxWidth: 220 }}
            placeholder="Search name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn" type="submit" disabled={busy}>Search</button>
        </form>
      </div>

      {rows.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No submissions match the current filters.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", opacity: 0.7 }}>
                <th style={{ padding: "8px 10px" }}>#</th>
                <th style={{ padding: "8px 10px" }}>Full name</th>
                <th style={{ padding: "8px 10px" }}>Department</th>
                <th style={{ padding: "8px 10px" }}>Team</th>
                <th style={{ padding: "8px 10px" }}>Lang</th>
                <th style={{ padding: "8px 10px" }}>Primary</th>
                <th style={{ padding: "8px 10px" }}>Secondary</th>
                <th style={{ padding: "8px 10px" }}>Submitted</th>
                <th style={{ padding: "8px 10px" }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
                  <td style={{ padding: "8px 10px", opacity: 0.7 }}>{row.id}</td>
                  <td style={{ padding: "8px 10px", fontWeight: 600 }}>
                    {row.fullName}
                    {row.duplicateCount > 1 && (
                      <span
                        title="Multiple submissions with this name + department"
                        style={{ marginLeft: 8, background: "rgba(250,178,25,0.2)", color: "#fab219", borderRadius: 999, padding: "2px 8px", fontSize: 12 }}
                      >
                        ⚠ ×{row.duplicateCount}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px" }}>{departmentLabels[row.department] || row.department}</td>
                  <td style={{ padding: "8px 10px" }}>{row.dispatchTeamName || "—"}</td>
                  <td style={{ padding: "8px 10px", textTransform: "uppercase" }}>{row.language}</td>
                  <td style={{ padding: "8px 10px" }}><PatternChip pattern={row.primaryPattern} /></td>
                  <td style={{ padding: "8px 10px" }}><PatternChip pattern={row.secondaryPattern} /></td>
                  <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{new Date(row.createdAt).toLocaleString()}</td>
                  <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                    <button className="btn" style={{ marginRight: 6 }} onClick={() => onOpenDetail(row.id)} disabled={busy}>
                      Open
                    </button>
                    <button className="btn" style={{ color: "#f87171" }} onClick={() => onDelete(row.id)} disabled={busy}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
