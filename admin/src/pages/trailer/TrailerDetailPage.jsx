import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { Card, Empty, PageHeader, Table, useLoad } from "./TrailerUi";
import { invoiceStatus, rentalStatus, trailerCondition } from "./trailerStatusVocabulary";

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const when = (d) => (d ? new Date(d).toLocaleString() : "—");
const day = (d) => (d ? new Date(d).toLocaleDateString() : "—");
const TABS = ["Overview", "Activity", "Documents", "Money", "History"];

const MOVEMENT_LABELS = { rental_pickup: "Picked up for a rental", rental_return: "Returned from a rental" };
const MEDIA_LABELS = {
  pickup_condition_photo: "Pickup photo",
  return_condition_photo: "Return photo",
  damage_photo: "Damage photo",
  payment_receipt: "Payment receipt",
  agreement_document: "Rental document",
  invoice_document: "Invoice document",
  other_rental_document: "Other document",
};

function Pill({ map, value }) {
  const s = map(value);
  return <span className={`trailer-pill trailer-pill-${s.tone}`}>{s.label}</span>;
}

/**
 * Trailer detail: Overview / Activity / Documents / Money / History.
 * History keeps the technical record (aliases, audit) collapsed behind
 * plain-language rows — nothing here is ever deleted.
 */
export default function TrailerDetailPage({ trailerId, onBack, onEdit }) {
  const [tab, setTab] = useState("Overview");
  const { data, loading, error } = useLoad(() => api.trailerOverview(trailerId), [trailerId]);
  const [showTechnical, setShowTechnical] = useState(false);

  if (loading) return <div className="loading"><div className="spinner" />Loading…</div>;
  if (error) return <div className="alert alert-danger">{error}</div>;
  const t = data.trailer;
  const condition = trailerCondition(t.physical_status);

  return (
    <div>
      <PageHeader
        title={`Trailer ${t.unit_number}`}
        subtitle={`${condition.label}${t.type ? ` · ${t.type}` : ""}${t.needs_review ? " · needs attention" : ""}`}
        actions={
          <div className="trailer-actions">
            {onEdit && (
              <button type="button" className="btn btn-primary" onClick={() => onEdit(t)}>Edit trailer</button>
            )}
            <button type="button" className="btn btn-ghost" onClick={onBack}>Back to trailers</button>
          </div>
        }
      />
      <div className="trailer-section-tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x}
            className={`trailer-section-tab ${tab === x ? "active" : ""}`} onClick={() => setTab(x)}>
            {x}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="trailer-two-col">
          <Card>
            <h3>Trailer</h3>
            <div className="trailer-summary trailer-summary-stack">
              <span>Condition: <Pill map={trailerCondition} value={t.physical_status} /></span>
              <span>Make / model: {[t.make, t.model].filter(Boolean).join(" ") || "—"}</span>
              <span>Plate: {t.plate_number || "—"} · VIN: {t.vin || "—"}</span>
              <span>Year: {t.year || "—"}</span>
              <span>Notes: {t.notes || "—"}</span>
            </div>
          </Card>
          <Card>
            <h3>Right now</h3>
            <div className="trailer-summary trailer-summary-stack">
              <span>Last known location: {t.current_location_text || "Unknown"}</span>
              <span>Who has the trailer: {t.possession_status ? String(t.possession_status).replaceAll("_", " ") : "Unknown"}</span>
              <span>Loaded or empty: {t.cargo_status || "Unknown"}</span>
              <span>Last update: {when(t.last_event_at)}</span>
            </div>
          </Card>
        </div>
      )}

      {tab === "Activity" && (
        <Card>
          {!data.movements.length ? <Empty>No pickups or returns recorded yet.</Empty> : (
            <Table rows={data.movements} columns={[
              { key: "movement_type", label: "What happened", render: (r) => MOVEMENT_LABELS[r.movement_type] || String(r.movement_type).replaceAll("_", " ") },
              { key: "to_location", label: "Where", render: (r) => r.to_location || "—" },
              { key: "event_at", label: "When", render: (r) => when(r.event_at) },
            ]} />
          )}
        </Card>
      )}

      {tab === "Documents" && (
        <Card>
          {!data.media.length ? <Empty>No photos or documents yet. They are added during pickups, returns and payments.</Empty> : (
            <Table rows={data.media} columns={[
              { key: "media_type", label: "Type", render: (r) => MEDIA_LABELS[r.media_type] || r.media_type },
              { key: "original_filename", label: "File" },
              { key: "created_at", label: "Added", render: (r) => day(r.created_at) },
            ]} />
          )}
        </Card>
      )}

      {tab === "Money" && (
        <Card>
          {!data.invoices.length ? <Empty>No invoices involve this trailer yet.</Empty> : (
            <Table rows={data.invoices} columns={[
              { key: "invoice_number", label: "Invoice" },
              { key: "status", label: "Status", render: (r) => <Pill map={invoiceStatus} value={r.status} /> },
              { key: "total_amount", label: "Total", render: (r) => usd(r.total_amount) },
              { key: "outstanding_balance", label: "Outstanding", render: (r) => usd(r.outstanding_balance) },
              { key: "due_at", label: "Due", render: (r) => day(r.due_at) },
            ]} />
          )}
        </Card>
      )}

      {tab === "History" && (
        <div>
          <Card>
            <h3>Previous rentals</h3>
            {!data.rentals.length ? <Empty>This trailer has never been rented.</Empty> : (
              <Table rows={data.rentals} columns={[
                { key: "display_number", label: "Rental" },
                { key: "company_name", label: "Company" },
                { key: "status", label: "Status", render: (r) => rentalStatus(r.status).label },
                { key: "start_at", label: "From", render: (r) => day(r.start_at) },
                { key: "end_at", label: "To", render: (r) => day(r.end_at) },
              ]} />
            )}
          </Card>
          {data.aliases.length > 0 && (
            <Card>
              <h3>Other numbers this trailer answers to</h3>
              <div className="trailer-summary">
                {data.aliases.map((a) => (
                  <span key={a.id} className={`trailer-pill trailer-pill-${a.active ? "neutral" : "attention"}`}>
                    {a.alias_unit_number}{a.active ? "" : " (inactive)"}
                  </span>
                ))}
              </div>
            </Card>
          )}
          <Card>
            <h3>Change log</h3>
            {!data.audit.length ? <Empty>No changes recorded.</Empty> : (
              <>
                {data.audit.slice(0, 20).map((row) => (
                  <div key={row.id} className="trailer-activity-row">
                    <span>{row.username || "Someone"} — {String(row.action).replaceAll(".", " ").replaceAll("_", " ")}</span>
                    <span className="trailer-attention-age">{when(row.created_at)}</span>
                  </div>
                ))}
                <button type="button" className="btn btn-link" onClick={() => setShowTechnical(!showTechnical)}>
                  {showTechnical ? "Hide technical detail" : "Show technical detail"}
                </button>
                {showTechnical && (
                  <pre className="trailer-json">{JSON.stringify(data.audit.slice(0, 20), null, 2)}</pre>
                )}
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
