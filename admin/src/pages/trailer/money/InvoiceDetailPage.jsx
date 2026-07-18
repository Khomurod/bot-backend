import React, { useState } from "react";
import api from "../../../api/trailerDepartment";
import { Card, Empty, PageHeader, Table, useLoad } from "../TrailerUi";
import { invoiceStatus } from "../trailerStatusVocabulary";

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const when = (d) => (d ? new Date(d).toLocaleString() : "—");
const day = (d) => (d ? new Date(d).toLocaleDateString() : "—");
const TABS = ["Overview", "Charges", "Payments", "Documents", "History"];

const LINE_LABELS = { rental: "Trailer rental", bundle: "Bundle rental" };

const MEDIA_TYPE_LABELS = {
  payment_receipt: "Payment receipt",
  invoice_document: "Invoice document",
  agreement_document: "Agreement document",
  other_rental_document: "Document",
};

/**
 * Documents tab (§4/§9): receipts and invoice documents with preview and
 * download. The list carries METADATA ONLY — a short-lived signed URL is
 * requested only at the moment preview/download is clicked, and is never shown
 * or logged.
 */
function DocumentsTab({ invoiceId, onError }) {
  const { data, loading, error } = useLoad(() => api.invoiceMedia(invoiceId), [invoiceId]);
  const [busyId, setBusyId] = useState(null);
  const rows = data?.media || [];

  const open = async (row, preview) => {
    setBusyId(row.id);
    try {
      const { url } = await api.mediaSignedUrl(row.id, { preview });
      // A fresh short-lived URL each click; opened directly, never stored.
      window.open(url, "_blank", "noopener");
    } catch (e) { onError(e.message); } finally { setBusyId(null); }
  };

  if (loading) return <div className="loading" role="status">Loading…</div>;
  if (error) return <div className="alert alert-danger" role="alert">{error}</div>;
  if (!rows.length) {
    return <Empty>No documents yet. Receipts appear here when payments are recorded.</Empty>;
  }
  return (
    <Table
      rows={rows}
      columns={[
        { key: "media_type", label: "Type", render: (r) => MEDIA_TYPE_LABELS[r.media_type] || "Document" },
        { key: "original_filename", label: "File" },
        { key: "created_at", label: "Uploaded", render: (r) => when(r.created_at) },
        { key: "uploaded_by", label: "By", render: (r) => r.uploaded_by || "—" },
        {
          key: "actions",
          label: "",
          render: (r) => (
            <span className="trailer-actions">
              <button type="button" className="btn btn-sm btn-secondary" disabled={busyId === r.id}
                onClick={(e) => { e.stopPropagation(); open(r, true); }}>
                Preview
              </button>
              <button type="button" className="btn btn-sm btn-secondary" disabled={busyId === r.id}
                onClick={(e) => { e.stopPropagation(); open(r, false); }}>
                Download
              </button>
            </span>
          ),
        },
      ]}
    />
  );
}

function Pill({ value }) {
  const s = invoiceStatus(value);
  return <span className={`trailer-pill trailer-pill-${s.tone}`}>{s.label}</span>;
}

/** Custom confirm for reversing a payment — needs a reason, never window.prompt. */
function ReverseDialog({ payment, busy, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal trailer-confirm">
        <h3>Reverse payment {payment.receipt_number}?</h3>
        <p>
          {usd(payment.amount)} is removed from what has been collected and the
          invoice balance goes back up. The payment record itself is kept.
        </p>
        <label htmlFor="reverse-reason">Why is this payment being reversed?</label>
        <textarea id="reverse-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="trailer-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Keep the payment
          </button>
          <button type="button" className="btn btn-danger" disabled={busy || !reason.trim()}
            onClick={() => onConfirm(reason.trim())}>
            Reverse payment
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Invoice detail: Overview / Charges (invoice lines in plain language) /
 * Payments (with reverse) / History (adjustments + audit, technical JSON
 * behind an Advanced toggle).
 */
export default function InvoiceDetailPage({ invoiceId, onBack, onRecordPayment, canReverse }) {
  const [tab, setTab] = useState("Overview");
  const { data, loading, error, reload } = useLoad(
    () => api.invoice(invoiceId).then((r) => r.invoice),
    [invoiceId],
  );
  const [reversing, setReversing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const auditLoad = useLoad(
    () => api.audit({ entityType: "invoice", entityId: invoiceId }),
    [invoiceId],
  );

  if (loading) return <div className="loading"><div className="spinner" />Loading…</div>;
  if (error) return <div className="alert alert-danger">{error}</div>;
  const inv = data;
  const payments = inv.payments || [];
  const lines = inv.lines || [];
  const adjustments = inv.adjustments || [];

  const reverse = async (reason) => {
    setBusy(true);
    try {
      await api.reversePayment(reversing.id, reason);
      setMsg({ type: "success", text: "Payment reversed." });
      setReversing(null);
      await reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader
        title={`Invoice ${inv.invoice_number}`}
        subtitle={`${inv.company_name}${inv.unit_number ? ` · trailer ${inv.unit_number}` : lines.length > 1 ? ` · ${lines.filter((l) => l.trailer_id).length} trailers` : ""} · ${usd(inv.outstanding_balance)} outstanding`}
        actions={
          <div className="trailer-actions">
            {Number(inv.outstanding_balance) > 0 && (
              <button type="button" className="btn btn-primary" onClick={() => onRecordPayment(inv)}>
                Record payment
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={onBack}>Back to invoices</button>
          </div>
        }
      />
      {msg && <div className={`alert ${msg.type === "error" ? "alert-danger" : "alert-success"}`}>{msg.text}</div>}
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
            <h3>Invoice</h3>
            <div className="trailer-summary trailer-summary-stack">
              <span>Status: <Pill value={inv.status} /></span>
              <span>Company: {inv.company_name}</span>
              <span>Rental: {inv.agreement_number || "—"}</span>
              <span>Billing period: {day(inv.billing_period_start)} – {day(inv.billing_period_end)}</span>
              <span>Due: {day(inv.due_at)}</span>
            </div>
          </Card>
          <Card>
            <h3>Amounts</h3>
            <div className="trailer-summary trailer-summary-stack">
              <span>Rental amount: {usd(inv.base_amount)}</span>
              {Number(inv.damage_charge) > 0 && <span>Damage: {usd(inv.damage_charge)}</span>}
              {Number(inv.cleaning_charge) > 0 && <span>Cleaning: {usd(inv.cleaning_charge)}</span>}
              {Number(inv.late_fee) > 0 && <span>Late fee: {usd(inv.late_fee)}</span>}
              {Number(inv.other_charges) > 0 && <span>Other charges: {usd(inv.other_charges)}</span>}
              {Number(inv.discount_amount) > 0 && <span>Discount: −{usd(inv.discount_amount)}</span>}
              {Number(inv.deposit_credit) > 0 && <span>Deposit applied: −{usd(inv.deposit_credit)}</span>}
              <span>Total: <b>{usd(inv.total_amount)}</b></span>
              <span>Collected so far: {usd(inv.total_paid)}</span>
              <span>Still owed: <b>{usd(inv.outstanding_balance)}</b></span>
            </div>
          </Card>
        </div>
      )}

      {tab === "Charges" && (
        <Card>
          {!lines.length ? (
            <Empty>This invoice has no line breakdown — its totals are shown on the Overview tab.</Empty>
          ) : (
            <Table rows={lines} columns={[
              { key: "line_type", label: "What", render: (r) => LINE_LABELS[r.line_type] || r.line_type },
              { key: "quantity", label: "Days / qty", render: (r) => `${Number(r.quantity)} ${r.unit || ""}` },
              { key: "unit_price", label: "Rate", render: (r) => usd(r.unit_price) },
              {
                key: "extras",
                label: "Extra charges",
                render: (r) => {
                  const extras = [["damage", r.damage_charge], ["cleaning", r.cleaning_charge],
                    ["late fee", r.late_fee], ["other", r.other_charge]]
                    .filter(([, v]) => Number(v) > 0)
                    .map(([k, v]) => `${k} ${usd(v)}`);
                  return extras.length ? extras.join(", ") : "—";
                },
              },
              { key: "line_total", label: "Line total", render: (r) => usd(r.line_total) },
            ]} />
          )}
        </Card>
      )}

      {tab === "Payments" && (
        <Card>
          {!payments.length ? <Empty>No payments recorded yet.</Empty> : (
            <Table rows={payments} columns={[
              { key: "receipt_number", label: "Receipt" },
              { key: "amount", label: "Amount", render: (r) => usd(r.amount) },
              { key: "payment_method", label: "Method" },
              { key: "payment_at", label: "When", render: (r) => day(r.payment_at) },
              {
                key: "verification_status",
                label: "Status",
                render: (r) => (r.verification_status === "reversed"
                  ? <span className="trailer-pill trailer-pill-attention">Reversed</span>
                  : <span className="trailer-pill trailer-pill-success">Recorded</span>),
              },
              {
                key: "actions",
                label: "",
                render: (r) => (canReverse && r.verification_status !== "reversed" ? (
                  <button type="button" className="btn btn-sm btn-ghost"
                    onClick={(e) => { e.stopPropagation(); setReversing(r); }}>
                    Reverse
                  </button>
                ) : null),
              },
            ]} />
          )}
        </Card>
      )}

      {tab === "Documents" && (
        <Card>
          <DocumentsTab invoiceId={invoiceId} onError={(text) => setMsg({ type: "error", text })} />
        </Card>
      )}
      {tab === "History" && (
        <Card>
          <h3>Adjustments</h3>
          {!adjustments.length ? <p className="trailer-empty-line">No adjustments.</p> : (
            <Table rows={adjustments} columns={[
              { key: "adjustment_type", label: "Type", render: (r) => String(r.adjustment_type).replaceAll("_", " ") },
              { key: "amount", label: "Amount", render: (r) => usd(r.amount) },
              { key: "reason", label: "Reason" },
              { key: "created_at", label: "When", render: (r) => when(r.created_at) },
            ]} />
          )}
          <h3>Change log</h3>
          {!auditLoad.data?.audit?.length ? <p className="trailer-empty-line">No changes recorded.</p> : (
            <>
              {auditLoad.data.audit.slice(0, 20).map((row) => (
                <div key={row.id} className="trailer-activity-row">
                  <span>{row.username || "Someone"} — {String(row.action).replaceAll(".", " ").replaceAll("_", " ")}</span>
                  <span className="trailer-attention-age">{when(row.created_at)}</span>
                </div>
              ))}
              <button type="button" className="btn btn-link" onClick={() => setShowTechnical(!showTechnical)}>
                {showTechnical ? "Hide technical detail" : "Show technical detail"}
              </button>
              {showTechnical && (
                <pre className="trailer-json">{JSON.stringify(auditLoad.data.audit.slice(0, 20), null, 2)}</pre>
              )}
            </>
          )}
        </Card>
      )}

      {reversing && (
        <ReverseDialog payment={reversing} busy={busy}
          onClose={() => setReversing(null)} onConfirm={reverse} />
      )}
    </div>
  );
}
