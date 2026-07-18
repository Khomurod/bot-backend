import React, { useMemo, useState } from "react";
import { Card, Empty, Field } from "../TrailerUi";
import {
  allIssues, buildDecisions, entryIssues, fieldDiffs, impactSummary,
} from "./reconcileDecisions";

const ACTION_LABELS = {
  skip: "Decide later",
  create: "Add to the trailer list",
  update: "Use the details from the upload",
  keep_verified: "Keep the current details",
  archive: "Archive this trailer",
  correct_unit: "Correct the unit number",
  merge: "Merge into another trailer",
};

const FIELD_LABELS = {
  make: "Make", model: "Model", mc_number: "MC number", plate_number: "Plate",
  type: "Type", vin: "VIN", year: "Year", ownership_status: "Ownership",
};

/** Side-by-side "current vs on the uploaded list" table. */
function DiffTable({ trailer, row }) {
  const diffs = fieldDiffs(trailer, row);
  if (!diffs.length) return <p className="trailer-help">The uploaded list matches the current details.</p>;
  return (
    <table className="trailer-table trailer-diff-table">
      <thead><tr><th>Field</th><th>Currently</th><th>On the uploaded list</th></tr></thead>
      <tbody>
        {diffs.map((d) => (
          <tr key={d.field}>
            <td>{FIELD_LABELS[d.field] || d.field}</td>
            <td>{String(d.current)}</td>
            <td><b>{String(d.incoming)}</b></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Searchable picker for the merge target — never a numeric id. */
function MergePicker({ trailers, excludeId, value, onChange }) {
  const [search, setSearch] = useState("");
  const matches = useMemo(() => {
    const q = search.trim().toUpperCase();
    const pool = trailers.filter((t) => String(t.id) !== String(excludeId));
    if (!q) return pool.slice(0, 6);
    return pool.filter((t) => String(t.unit_number).toUpperCase().includes(q)).slice(0, 6);
  }, [search, trailers, excludeId]);
  const chosen = trailers.find((t) => String(t.id) === String(value));
  return (
    <div>
      <Field label="Merge into which trailer?">
        <input
          placeholder="Type part of the unit number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </Field>
      {chosen && <p className="trailer-help">Merging into <b>{chosen.unit_number}</b>.</p>}
      <div className="trailer-picker-list" role="listbox" aria-label="Merge target">
        {matches.map((t) => (
          <button key={t.id} type="button" role="option"
            aria-selected={String(value) === String(t.id)}
            className={`trailer-picker-option ${String(value) === String(t.id) ? "active" : ""}`}
            onClick={() => onChange(t.id)}>
            <b>{t.unit_number}</b>
            <span>{t.type || ""}</span>
          </button>
        ))}
        {!matches.length && <p className="trailer-empty-line">No trailers match that search.</p>}
      </div>
    </div>
  );
}

function RowCard({ title, confidence, actions, entry, onChange, trailers, excludeId, children }) {
  const v = entry || { action: "skip" };
  const set = (patch) => onChange({ ...v, ...patch });
  const issues = entryIssues(v);
  return (
    <Card className="trailer-recon-row">
      <div className="trailer-actions" style={{ justifyContent: "space-between" }}>
        <strong>{title}</strong>
        {confidence != null && <span className="trailer-attention-age">read confidence {confidence}%</span>}
      </div>
      {children}
      <div className="trailer-form-grid">
        <Field label="What should happen?">
          <select value={v.action || "skip"} onChange={(e) => set({ action: e.target.value })}>
            <option value="skip">{ACTION_LABELS.skip}</option>
            {actions.map((a) => <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>)}
          </select>
        </Field>
        {v.action === "correct_unit" && (
          <Field label="Corrected unit number">
            <input value={v.new_unit_number || ""} onChange={(e) => set({ new_unit_number: e.target.value })} />
          </Field>
        )}
        {v.action && v.action !== "skip" && (
          <Field label={["archive", "merge", "correct_unit"].includes(v.action) ? "Reason (required)" : "Reason (optional)"}>
            <input value={v.reason || ""} onChange={(e) => set({ reason: e.target.value })} />
          </Field>
        )}
      </div>
      {v.action === "merge" && (
        <MergePicker trailers={trailers} excludeId={excludeId}
          value={v.merge_into_trailer_id} onChange={(id) => set({ merge_into_trailer_id: id })} />
      )}
      {issues.map((issue) => <p key={issue} className="trailer-field-error">{issue}</p>)}
    </Card>
  );
}

function Section({ title, intro, count, children }) {
  const [open, setOpen] = useState(count > 0);
  return (
    <div className="trailer-recon-section">
      <button type="button" className="trailer-group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <h3>{title} ({count})</h3>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (count ? <><p className="trailer-help">{intro}</p>{children}</> : <Empty>Nothing in this group.</Empty>)}
    </div>
  );
}

/**
 * Review of one confirmed trailer-list upload: summary counts first, then each
 * group with side-by-side differences and a plain decision per row. Archive,
 * merge and number-correction require a written reason; Apply shows exactly
 * what will happen before anything changes.
 */
export default function ReconciliationPanel({ data, busy, onApply, trailers = [] }) {
  const groups = {
    matched: data.matched || [],
    new: data.new || [],
    missing: data.missing || [],
    conflicting: data.conflicting || [],
  };
  const [state, setState] = useState({});
  const set = (key, entry) => setState((prev) => ({ ...prev, [key]: entry }));

  const decisions = buildDecisions(groups, state);
  const issues = allIssues(state);
  const blocked = Object.keys(issues).length > 0;
  const changedMatches = groups.matched.filter((g) => (g.changes || []).length || fieldDiffs(g.trailer, g.row).length);
  const cleanMatches = groups.matched.length - changedMatches.length;

  return (
    <div>
      {data.summary && (
        <div className="trailer-summary">
          <span>Rows on the uploaded list: <b>{data.summary.snapshot_rows}</b></span>
          <span>Matched: {data.summary.matched}</span>
          <span>New: {data.summary.new}</span>
          <span>Missing: {data.summary.missing}</span>
          <span>Different details: {data.summary.conflicting}</span>
          {cleanMatches > 0 && <span>{cleanMatches} matched with no changes</span>}
        </div>
      )}

      <Section title="New trailers" intro="These numbers are on the uploaded list but not in the system yet." count={groups.new.length}>
        {groups.new.map((g) => (
          <RowCard key={g.row.import_row_id} title={g.row.unit_number}
            confidence={g.row.confidence ?? g.row.ai_confidence}
            actions={["create"]}
            entry={state[`new:${g.row.import_row_id}`]}
            onChange={(entry) => set(`new:${g.row.import_row_id}`, entry)}
            trailers={trailers}>
            <DiffTable trailer={{}} row={g.row} />
          </RowCard>
        ))}
      </Section>

      <Section title="Different details" intro="The uploaded list disagrees with the current record. Compare side by side and choose which is right." count={groups.conflicting.length}>
        {groups.conflicting.map((g) => (
          <RowCard key={g.trailer.id} title={g.trailer.unit_number}
            confidence={g.row?.confidence ?? g.row?.ai_confidence}
            actions={["update", "keep_verified"]}
            entry={state[`conflicting:${g.trailer.id}`]}
            onChange={(entry) => set(`conflicting:${g.trailer.id}`, entry)}
            trailers={trailers}>
            <DiffTable trailer={g.trailer} row={g.row} />
          </RowCard>
        ))}
      </Section>

      <Section title="Missing from the uploaded list" intro="These trailers are in the system but not on the uploaded list. Archive, correct the number, or merge duplicates — with a reason." count={groups.missing.length}>
        {groups.missing.map((g) => (
          <RowCard key={g.trailer.id} title={g.trailer.unit_number}
            actions={g.available_actions || ["keep_verified", "archive", "correct_unit", "merge"]}
            entry={state[`missing:${g.trailer.id}`]}
            onChange={(entry) => set(`missing:${g.trailer.id}`, entry)}
            trailers={trailers} excludeId={g.trailer.id} />
        ))}
      </Section>

      <Section title="Matched with changed details" intro="Found in the system, with some details different on the uploaded list." count={changedMatches.length}>
        {changedMatches.map((g) => (
          <RowCard key={g.trailer.id} title={g.trailer.unit_number}
            confidence={g.row?.confidence ?? g.row?.ai_confidence}
            actions={["update", "keep_verified"]}
            entry={state[`matched:${g.trailer.id}`]}
            onChange={(entry) => set(`matched:${g.trailer.id}`, entry)}
            trailers={trailers}>
            <DiffTable trailer={g.trailer} row={g.row} />
          </RowCard>
        ))}
      </Section>

      <Card>
        <h3>What will happen</h3>
        <p>{impactSummary(decisions)}</p>
        {blocked && (
          <p className="trailer-field-error">
            Some decisions are incomplete — add the missing reasons or choices above before applying.
          </p>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !decisions.length || blocked}
          onClick={() => onApply(decisions)}
        >
          {busy ? "Applying…" : `Apply ${decisions.length} decision${decisions.length === 1 ? "" : "s"}`}
        </button>
        <p className="trailer-help">
          Everything is applied together — if any decision fails, none of them change the list.
        </p>
      </Card>
    </div>
  );
}
