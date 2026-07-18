import React, { useState } from "react";
import api from "../../../api/trailerDepartment";
import { Card, Empty, Field, PageHeader, useLoad } from "../TrailerUi";
import { auditSentence } from "./auditVocabulary";

const when = (d) => (d ? new Date(d).toLocaleString() : "—");

const TYPE_FILTERS = [
  ["", "Everything"],
  ["rental", "Rentals"],
  ["rental_item", "Trailers on rentals"],
  ["agreement", "Rental agreements"],
  ["invoice", "Invoices"],
  ["payment", "Payments"],
  ["company_credit", "Company credits"],
  ["trailer", "Trailers"],
  ["company", "Companies"],
  ["inspection", "Inspections"],
];

/**
 * The audit trail in plain sentences — who did what, when. The raw technical
 * record (old/new values) stays available per row behind "Show detail".
 */
export default function AuditPage() {
  const [entityType, setEntityType] = useState("");
  const { data, loading, error, reload } = useLoad(
    () => api.audit(entityType ? { entityType } : {}),
    [entityType],
  );
  const [expanded, setExpanded] = useState(null);

  const rows = data?.audit || [];

  return (
    <div>
      <PageHeader
        title="Audit trail"
        subtitle="Every change in the Trailer Department — who did what, and when. Nothing is ever deleted."
        actions={<button type="button" className="btn btn-secondary" onClick={reload}>Refresh</button>}
      />
      <Field label="Show changes about">
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          {TYPE_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      {error && <div className="alert alert-danger">{error}</div>}
      <Card>
        {loading ? (
          <div className="loading"><div className="spinner" />Loading…</div>
        ) : !rows.length ? (
          <Empty>No recorded changes match this filter yet.</Empty>
        ) : rows.map((row) => (
          <div key={row.id} className="trailer-audit-row">
            <div className="trailer-activity-row">
              <span>{auditSentence(row)}</span>
              <span className="trailer-attention-age">{when(row.created_at)}</span>
              <button type="button" className="btn btn-sm btn-ghost"
                onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                {expanded === row.id ? "Hide detail" : "Show detail"}
              </button>
            </div>
            {expanded === row.id && (
              <pre className="trailer-json">
                {JSON.stringify({
                  action: row.action,
                  entity: `${row.entity_type} #${row.entity_id}`,
                  reason: row.reason || undefined,
                  old_values: row.old_values || undefined,
                  new_values: row.new_values || undefined,
                }, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
