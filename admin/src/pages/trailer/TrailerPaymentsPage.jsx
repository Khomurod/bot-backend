import React, { useState } from "react";
import api from "./../../api/trailerDepartment";
import { useAuth } from "../../context/AuthContext";
import { Alert, Card, Empty, Field, PageHeader, Table, useLoad } from "./TrailerUi";
import { invoiceStatus } from "./trailerStatusVocabulary";

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

function StatusPill({ value }) {
  const s = invoiceStatus(value);
  return <span className={`trailer-pill trailer-pill-${s.tone}`}>{s.label}</span>;
}

/**
 * Invoices & payments. Recording a payment shows the outstanding balance up
 * front; an amount above it triggers the overpayment confirmation ("save the
 * extra as company credit?") — offered ONLY to holders of
 * trailer_payments.record_overpayment, otherwise the server rejects it.
 */
export default function TrailerPaymentsPage({ statusFilter, onOpenInvoice }) {
  const { can } = useAuth();
  const list = useLoad(
    () => api.invoices(statusFilter ? { status: statusFilter } : {}),
    [statusFilter],
  );
  const [selected, setSelected] = useState(null);
  const [msg, setMsg] = useState(null);

  const rows = list.data?.invoices || [];

  return (
    <div>
      <PageHeader
        title={statusFilter === "overdue" ? "Overdue balances" : "Invoices and payments"}
        subtitle={statusFilter === "overdue"
          ? "Invoices past their due date with money still owed."
          : "Every invoice with what has been collected and what is still owed."}
      />
      <Alert message={msg} />
      {list.error && <div className="alert alert-danger">{list.error}</div>}
      {list.loading ? (
        <div className="loading"><div className="spinner" />Loading…</div>
      ) : !rows.length ? (
        <Empty>
          {statusFilter === "overdue"
            ? "Nothing is overdue — all invoices are paid or within their due date."
            : "No invoices yet. An invoice is created when a trailer is returned."}
        </Empty>
      ) : (
        <Table
          rows={rows}
          onRow={onOpenInvoice || setSelected}
          columns={[
            { key: "invoice_number", label: "Invoice" },
            { key: "unit_number", label: "Trailer", render: (r) => r.unit_number || "Multiple" },
            { key: "company_name", label: "Company" },
            { key: "agreement_number", label: "Rental" },
            { key: "status", label: "Status", render: (r) => <StatusPill value={r.status} /> },
            { key: "total_amount", label: "Invoiced", render: (r) => usd(r.total_amount) },
            { key: "total_paid", label: "Collected", render: (r) => usd(r.total_paid) },
            { key: "outstanding_balance", label: "Outstanding", render: (r) => usd(r.outstanding_balance) },
            { key: "due_at", label: "Due", render: (r) => (r.due_at ? new Date(r.due_at).toLocaleDateString() : "—") },
          ]}
        />
      )}
      {selected && (
        <PaymentDialog
          invoice={selected}
          can={can}
          onClose={() => setSelected(null)}
          onSaved={(text) => {
            setMsg({ text });
            setSelected(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

export function PaymentDialog({ invoice, can, onClose, onSaved }) {
  const [form, setForm] = useState({
    amount: "", method: "ACH", reference: "", date: new Date().toISOString().slice(0, 10),
    bypassReason: "",
  });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // null | { excess } — the explicit overpayment confirmation step.
  const [confirmOver, setConfirmOver] = useState(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const outstanding = Number(invoice.outstanding_balance || 0);
  const excess = Number(form.amount || 0) - outstanding;
  const canOverpay = can("trailer_payments.record_overpayment");
  const set = (patch) => setForm({ ...form, ...patch });

  const save = async (confirmOverpayment) => {
    setBusy(true);
    setError("");
    try {
      const result = await api.recordPayment({
        invoice_id: invoice.id,
        amount: form.amount,
        payment_at: new Date(`${form.date}T12:00:00`).toISOString(),
        payment_method: form.method,
        reference_number: form.reference,
        receipt_bypass_reason: file ? undefined : form.bypassReason,
        confirm_overpayment: confirmOverpayment ? "true" : undefined,
        idempotency_key: idempotencyKey,
      }, file);
      onSaved(result.credit
        ? `Payment saved. ${usd(result.credit.original_amount)} extra was saved as company credit.`
        : "Payment saved. The confirmation is on its way to Telegram.");
    } catch (err) {
      setError(err.message);
      setBusy(false);
      setConfirmOver(null);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (busy) return;
    if (excess > 0.0001) {
      if (!canOverpay) {
        setError(`That is ${usd(excess)} more than the remaining balance of ${usd(outstanding)}. `
          + "Enter an amount up to the balance, or ask someone authorized to record extra payments.");
        return;
      }
      setConfirmOver({ excess });
      return;
    }
    save(false);
  };

  return (
    <div className="trailer-modal-backdrop" role="dialog" aria-modal="true">
      <Card className="trailer-modal">
        <PageHeader
          title={`Record payment — ${invoice.invoice_number}`}
          subtitle={`Remaining balance: ${usd(outstanding)}`}
          actions={<button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>Close</button>}
        />
        {error && <div className="alert alert-danger">{error}</div>}
        {confirmOver ? (
          <div>
            <p>
              This payment is <b>{usd(confirmOver.excess)}</b> more than the remaining balance
              of {usd(outstanding)}. Save the extra amount as company credit for {invoice.company_name}?
            </p>
            <div className="trailer-actions">
              <button type="button" className="btn btn-secondary" disabled={busy}
                onClick={() => setConfirmOver(null)}>
                Go back and change the amount
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(true)}>
                {busy ? "Saving…" : "Save payment and keep the extra as credit"}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="trailer-form-grid">
            <Field label="Amount">
              <input required type="number" min="0.01" step="0.01" value={form.amount}
                onChange={(e) => set({ amount: e.target.value })} />
            </Field>
            <Field label="Payment date">
              <input required type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} />
            </Field>
            <Field label="Payment method">
              <select value={form.method} onChange={(e) => set({ method: e.target.value })}>
                {["ACH", "Check", "Cash", "Card", "Wire", "Other"].map((x) => <option key={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="Reference (optional)">
              <input value={form.reference} onChange={(e) => set({ reference: e.target.value })} />
            </Field>
            <Field label="Receipt">
              <input
                required={!can("trailer_payments.record_without_receipt") || !form.bypassReason}
                type="file" accept="image/*,application/pdf" capture="environment"
                onChange={(e) => setFile(e.target.files[0])}
              />
            </Field>
            {can("trailer_payments.record_without_receipt") && (
              <Field label="No-receipt reason (authorized bypass)">
                <input value={form.bypassReason} onChange={(e) => set({ bypassReason: e.target.value })} />
              </Field>
            )}
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save payment"}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}
