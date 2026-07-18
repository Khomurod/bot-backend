import React, { useState } from "react";
import dept from "../../../api/trailerDepartment";
import { Card, Empty, Field, Modal, PageHeader, useLoad } from "../TrailerUi";

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

/**
 * Available company credit: pick a company, see its credits, apply a credit to
 * an open invoice. Applying reduces the invoice balance immediately (the server
 * caps the application at the invoice's outstanding amount).
 */
export default function CompanyCreditsPage() {
  const companies = useLoad(() => dept.companies({ active: true }), []);
  const [companyId, setCompanyId] = useState("");
  const [msg, setMsg] = useState(null);
  const [applying, setApplying] = useState(null); // credit row
  const credits = useLoad(
    () => (companyId ? dept.companyCredits(companyId) : Promise.resolve({ credits: [] })),
    [companyId],
  );
  const invoices = useLoad(
    () => (companyId ? dept.invoices({ companyId }) : Promise.resolve({ invoices: [] })),
    [companyId],
  );

  const openInvoices = (invoices.data?.invoices || [])
    .filter((i) => Number(i.outstanding_balance) > 0 && !["voided", "disputed"].includes(i.status));

  return (
    <div>
      <PageHeader
        title="Company credits"
        subtitle="Extra payments saved as credit, ready to apply to open invoices."
      />
      {msg && <div className={`alert ${msg.type === "error" ? "alert-danger" : "alert-success"}`}>{msg.text}</div>}
      <Field label="Company">
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">Choose a company…</option>
          {(companies.data?.companies || []).map((c) => (
            <option key={c.id} value={c.id}>{c.display_name}</option>
          ))}
        </select>
      </Field>
      {companyId && !credits.loading && !(credits.data?.credits || []).length && (
        <Card>
          <Empty>
            This company has no credits. A credit appears when an authorized extra
            payment is saved while recording a payment.
          </Empty>
        </Card>
      )}
      {(credits.data?.credits || []).map((c) => (
        <Card key={c.id}>
          <div className="trailer-summary">
            <span>Created {c.created_at ? new Date(c.created_at).toLocaleDateString() : "—"}</span>
            <span>Original: {usd(c.original_amount)}</span>
            <span>Remaining: <b>{usd(c.remaining_amount)}</b></span>
            <span>{c.reason || ""}</span>
          </div>
          {Number(c.remaining_amount) > 0 && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setApplying(c)}>
              Apply to an invoice
            </button>
          )}
        </Card>
      ))}
      {applying && (
        <ApplyDialog
          credit={applying}
          invoices={openInvoices}
          onClose={() => setApplying(null)}
          onDone={async (applied) => {
            setApplying(null);
            setMsg({ text: `Applied ${usd(applied.applied_amount)} of credit.` });
            await Promise.all([credits.reload(), invoices.reload()]);
          }}
          onError={(text) => setMsg({ type: "error", text })}
        />
      )}
    </div>
  );
}

function ApplyDialog({ credit, invoices, onClose, onDone, onError }) {
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState(String(credit.remaining_amount));
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    try {
      const { credit: applied } = await dept.applyCredit(credit.id, {
        invoice_id: Number(invoiceId), amount: Number(amount) || undefined,
      });
      onDone(applied);
    } catch (e) {
      onError(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Apply credit to an invoice" onClose={busy ? undefined : onClose}>
      {!invoices.length ? (
        <Empty>No open invoices for this company right now.</Empty>
      ) : (
        <div className="trailer-form-grid">
          <Field label="Invoice">
            <select required value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">Choose an invoice…</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoice_number} — {usd(i.outstanding_balance)} outstanding
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Amount (up to ${usd(credit.remaining_amount)})`}>
            <input type="number" min="0.01" step="0.01" value={amount}
              onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="trailer-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !invoiceId} onClick={apply}>
          {busy ? "Applying…" : "Apply credit"}
        </button>
      </div>
    </Modal>
  );
}
