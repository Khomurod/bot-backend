import React, { useState } from "react";
import { Card, Empty } from "../TrailerUi";

const ROW_FIELDS = [
  "make",
  "model",
  "mc_number",
  "plate_number",
  "type",
  "vin",
  "year",
  "ownership_status",
];

function pickRowFields(row) {
  const out = {};
  for (const f of ROW_FIELDS) if (row[f] != null && row[f] !== "") out[f] = row[f];
  return out;
}

// Turn the per-row editor state into the decision objects the API expects.
function buildDecisions(groups, state) {
  const decisions = [];
  for (const [key, entry] of Object.entries(state)) {
    if (!entry || !entry.action || entry.action === "skip") continue;
    const [group, id] = key.split(":");
    if (group === "new") {
      const g = groups.new.find((x) => String(x.row.import_row_id) === id);
      if (!g) continue;
      decisions.push({
        decision: "create",
        unit_number: g.row.unit_number,
        import_row_id: g.row.import_row_id,
        reason: entry.reason || null,
        ...pickRowFields(g.row),
      });
    } else if (group === "matched" || group === "conflicting") {
      const source = groups[group].find((x) => String(x.trailer.id) === id);
      if (!source) continue;
      if (entry.action === "update") {
        decisions.push({
          decision: "update",
          trailer_id: source.trailer.id,
          import_row_id: source.row.import_row_id,
          reason: entry.reason || null,
          ...pickRowFields(source.row),
        });
      } else if (entry.action === "keep_verified") {
        decisions.push({
          decision: "keep_verified",
          trailer_id: source.trailer.id,
          reason: entry.reason || null,
        });
      }
    } else if (group === "missing") {
      const g = groups.missing.find((x) => String(x.trailer.id) === id);
      if (!g) continue;
      decisions.push({
        decision: entry.action,
        trailer_id: g.trailer.id,
        reason: entry.reason || null,
        new_unit_number: entry.new_unit_number || undefined,
        merge_into_trailer_id: entry.merge_into_trailer_id || undefined,
      });
    }
  }
  return decisions;
}

function RowEditor({ label, actions, value, onChange }) {
  const v = value || { action: "skip" };
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <div className="trailer-summary" style={{ alignItems: "center", gap: 8 }}>
      <strong>{label}</strong>
      <select value={v.action || "skip"} onChange={(e) => set({ action: e.target.value })}>
        <option value="skip">Skip</option>
        {actions.map((a) => (
          <option key={a} value={a}>
            {a.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      {v.action === "correct_unit" && (
        <input
          placeholder="New unit number"
          value={v.new_unit_number || ""}
          onChange={(e) => set({ new_unit_number: e.target.value })}
        />
      )}
      {v.action === "merge" && (
        <input
          placeholder="Merge into trailer id"
          value={v.merge_into_trailer_id || ""}
          onChange={(e) => set({ merge_into_trailer_id: e.target.value })}
        />
      )}
      {v.action && v.action !== "skip" && (
        <input
          placeholder="Reason"
          value={v.reason || ""}
          onChange={(e) => set({ reason: e.target.value })}
        />
      )}
    </div>
  );
}

function Group({ title, children, empty }) {
  return (
    <Card>
      <h3>{title}</h3>
      {children.length ? children : <Empty>{empty}</Empty>}
    </Card>
  );
}

/**
 * Reconciliation review for one confirmed snapshot. Each row gets a decision
 * control; Apply gathers the non-skip decisions and hands them to the caller.
 */
export default function ReconciliationPanel({ data, busy, onApply }) {
  const groups = {
    matched: data.matched || [],
    new: data.new || [],
    missing: data.missing || [],
    conflicting: data.conflicting || [],
  };
  const [state, setState] = useState({});
  const set = (key, entry) => setState((prev) => ({ ...prev, [key]: entry }));

  const decisions = buildDecisions(groups, state);

  return (
    <div>
      {data.summary && (
        <div className="trailer-summary">
          <span>Snapshot rows: {data.summary.snapshot_rows}</span>
          <span>Matched: {data.summary.matched}</span>
          <span>New: {data.summary.new}</span>
          <span>Missing: {data.summary.missing}</span>
          <span>Conflicting: {data.summary.conflicting}</span>
        </div>
      )}
      <Group title="New (not on master list)" empty="No new trailers.">
        {groups.new.map((g) => (
          <RowEditor
            key={g.row.import_row_id}
            label={g.row.unit_number}
            actions={["create"]}
            value={state[`new:${g.row.import_row_id}`]}
            onChange={(entry) => set(`new:${g.row.import_row_id}`, entry)}
          />
        ))}
      </Group>
      <Group title="Conflicting" empty="No conflicts.">
        {groups.conflicting.map((g) => (
          <RowEditor
            key={g.trailer.id}
            label={`${g.trailer.unit_number} (${(g.conflicts || []).map((c) => c.field || c).join(", ")})`}
            actions={["update", "keep_verified"]}
            value={state[`conflicting:${g.trailer.id}`]}
            onChange={(entry) => set(`conflicting:${g.trailer.id}`, entry)}
          />
        ))}
      </Group>
      <Group title="Missing from snapshot" empty="Nothing missing.">
        {groups.missing.map((g) => (
          <RowEditor
            key={g.trailer.id}
            label={g.trailer.unit_number}
            actions={g.available_actions || ["keep_verified", "archive", "correct_unit", "merge"]}
            value={state[`missing:${g.trailer.id}`]}
            onChange={(entry) => set(`missing:${g.trailer.id}`, entry)}
          />
        ))}
      </Group>
      <Group title="Matched" empty="No matches.">
        {groups.matched.map((g) => (
          <RowEditor
            key={g.trailer.id}
            label={`${g.trailer.unit_number}${(g.changes || []).length ? " (changes)" : ""}`}
            actions={["update"]}
            value={state[`matched:${g.trailer.id}`]}
            onChange={(entry) => set(`matched:${g.trailer.id}`, entry)}
          />
        ))}
      </Group>
      <div className="trailer-actions" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !decisions.length}
          onClick={() => onApply(decisions)}
        >
          {busy ? "Applying…" : `Apply ${decisions.length} decision(s)`}
        </button>
      </div>
    </div>
  );
}
