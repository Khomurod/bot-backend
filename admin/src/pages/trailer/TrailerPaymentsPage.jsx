import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { useAuth } from "../../context/AuthContext";
import {
  Alert,
  Card,
  Empty,
  Field,
  PageHeader,
  Status,
  Table,
  useLoad,
} from "./TrailerUi";
export default function TrailerPaymentsPage() {
  const { can } = useAuth();
  const list = useLoad(() => api.invoices(), []);
  const [selected, setSelected] = useState(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("ACH");
  const [reference, setReference] = useState("");
  const [file, setFile] = useState(null);
  const [bypassReason, setBypassReason] = useState("");
  const [msg, setMsg] = useState(null);
  const pay = async (e) => {
    e.preventDefault();
    try {
      await api.recordPayment(
        {
          invoice_id: selected.id,
          amount,
          payment_at: new Date().toISOString(),
          payment_method: method,
          reference_number: reference,
          receipt_bypass_reason: file ? undefined : bypassReason,
          idempotency_key: crypto.randomUUID(),
        },
        file,
      );
      setMsg({ text: "Payment saved. Telegram delivery is queued." });
      setSelected(null);
      list.reload();
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    }
  };
  return (
    <div>
      <PageHeader
        title="Invoices and Payments"
        subtitle="Collected and outstanding amounts are derived from immutable payment records."
      />
      <Alert message={msg} />
      {list.error && <div className="alert alert-danger">{list.error}</div>}
      {list.loading ? (
        <div className="loading">Loading…</div>
      ) : !list.data?.invoices?.length ? (
        <Empty>No invoices yet.</Empty>
      ) : (
        <Table
          rows={list.data.invoices}
          onRow={setSelected}
          columns={[
            { key: "invoice_number", label: "Invoice" },
            { key: "unit_number", label: "Trailer" },
            { key: "company_name", label: "Company" },
            {
              key: "status",
              label: "Status",
              render: (r) => <Status value={r.status} />,
            },
            {
              key: "total_amount",
              label: "Invoiced",
              render: (r) => `$${Number(r.total_amount).toFixed(2)}`,
            },
            {
              key: "total_paid",
              label: "Collected",
              render: (r) => `$${Number(r.total_paid).toFixed(2)}`,
            },
            {
              key: "outstanding_balance",
              label: "Outstanding",
              render: (r) => `$${Number(r.outstanding_balance).toFixed(2)}`,
            },
            {
              key: "due_at",
              label: "Due",
              render: (r) => new Date(r.due_at).toLocaleDateString(),
            },
            { key: "notification_status", label: "Telegram", render: (r) => <Status value={r.notification_status || "not_queued"}/> },
          ]}
        />
      )}{" "}
      {selected && (
        <div className="trailer-modal-backdrop">
          <Card className="trailer-modal">
            <PageHeader
              title={`Record payment — ${selected.invoice_number}`}
              actions={
                <button
                  className="btn btn-ghost"
                  onClick={() => setSelected(null)}
                >
                  Close
                </button>
              }
            />
            <form onSubmit={pay} className="trailer-form-grid">
              <Field label="Amount">
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field label="Payment method">
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  {["ACH", "Check", "Cash", "Card", "Wire", "Other"].map(
                    (x) => (
                      <option key={x}>{x}</option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="Reference">
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </Field>
            <Field label="Receipt">
              <input
                required={!can("trailer_payments.record_without_receipt") || !bypassReason}
                  type="file"
                  accept="image/*,application/pdf"
                  capture="environment"
                  onChange={(e) => setFile(e.target.files[0])}
              />
            </Field>
            {can("trailer_payments.record_without_receipt") && <Field label="No-receipt reason (authorized bypass)"><input value={bypassReason} onChange={(e) => setBypassReason(e.target.value)}/></Field>}
              <button className="btn btn-primary" type="submit">
                Save payment
              </button>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
