import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { Alert, Card, Empty, Field, PageHeader, Table, useLoad } from "./TrailerUi";
import { invoiceStatus, rentalStatus } from "./trailerStatusVocabulary";

const EMPTY = {
  legal_name: "", display_name: "", contact_name: "", phone: "", email: "",
  payment_terms: "", default_daily_rate: "", notes: "",
};
const FIELD_LABELS = {
  legal_name: "Legal name", display_name: "Company name", contact_name: "Contact person",
  phone: "Phone", email: "Email", payment_terms: "Payment terms",
  default_daily_rate: "Default daily rate", notes: "Notes",
};
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

export default function TrailerCompaniesPage({ navigate }) {
  const { data, loading, error, reload } = useLoad(() => api.companies(), []);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null); // company row
  const [confirmArchive, setConfirmArchive] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createCompany(form);
      setForm(null);
      setMsg({ text: "Company added." });
      reload();
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    } finally { setBusy(false); }
  };

  const archive = async (row) => {
    setBusy(true);
    try {
      await api.updateCompany(row.id, { ...row, active: false, reason: "Archived from Trailer Department" });
      setConfirmArchive(null);
      setMsg({ text: `${row.display_name} archived. Its history stays available.` });
      reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally { setBusy(false); }
  };

  if (detail) {
    return (
      <CompanyDetail
        company={detail}
        navigate={navigate}
        onBack={() => setDetail(null)}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Companies"
        subtitle="Companies that rent trailers. Companies with history are archived, never deleted."
        actions={<button type="button" className="btn btn-primary" onClick={() => setForm({ ...EMPTY })}>Add company</button>}
      />
      <Alert message={msg} />
      {error && <div className="alert alert-danger">{error}</div>}
      {loading ? (
        <div className="loading"><div className="spinner" />Loading…</div>
      ) : !data?.companies?.length ? (
        <Card>
          <Empty>No companies yet. Add the first company to start renting trailers.</Empty>
          <button type="button" className="btn btn-primary" onClick={() => setForm({ ...EMPTY })}>Add company</button>
        </Card>
      ) : (
        <Table
          rows={data.companies}
          onRow={setDetail}
          columns={[
            { key: "display_name", label: "Company" },
            { key: "contact_name", label: "Contact" },
            { key: "phone", label: "Phone" },
            { key: "active_rentals", label: "Active rentals" },
            { key: "outstanding_balance", label: "Outstanding", render: (r) => usd(r.outstanding_balance) },
            { key: "active", label: "Status", render: (r) => (r.active ? "Active" : "Archived") },
            {
              key: "actions",
              label: "",
              render: (r) => (r.active ? (
                <button type="button" className="btn btn-sm btn-ghost"
                  onClick={(e) => { e.stopPropagation(); setConfirmArchive(r); }}>
                  Archive
                </button>
              ) : null),
            },
          ]}
        />
      )}
      {form && (
        <div className="trailer-modal-backdrop" role="dialog" aria-modal="true">
          <Card className="trailer-modal">
            <PageHeader title="Add company"
              actions={<button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Close</button>} />
            <form onSubmit={save} className="trailer-form-grid">
              {Object.keys(EMPTY).map((key) => (
                <Field key={key} label={FIELD_LABELS[key]}>
                  {key === "notes" ? (
                    <textarea value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                  ) : (
                    <input
                      required={["legal_name", "display_name"].includes(key)}
                      type={key === "default_daily_rate" ? "number" : key === "email" ? "email" : "text"}
                      value={form[key]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    />
                  )}
                </Field>
              ))}
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save company"}
              </button>
            </form>
          </Card>
        </div>
      )}
      {confirmArchive && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal trailer-confirm">
            <h3>Archive {confirmArchive.display_name}?</h3>
            <p>
              The company disappears from pickers and lists but keeps every rental,
              invoice and payment record. You can reactivate it later.
            </p>
            <div className="trailer-actions">
              <button type="button" className="btn btn-secondary" disabled={busy}
                onClick={() => setConfirmArchive(null)}>
                Keep the company active
              </button>
              <button type="button" className="btn btn-danger" disabled={busy}
                onClick={() => archive(confirmArchive)}>
                Archive company
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Company detail: contacts, rentals, invoices, credits, outstanding. */
function CompanyDetail({ company, navigate, onBack }) {
  const rentals = useLoad(() => api.rentalList({ company_id: company.id, page_size: 50 }), [company.id]);
  const invoices = useLoad(() => api.invoices({ companyId: company.id }), [company.id]);
  const credits = useLoad(() => api.companyCredits(company.id), [company.id]);

  const invoiceRows = invoices.data?.invoices || [];
  const outstanding = invoiceRows.reduce((s, i) => s + Number(i.outstanding_balance || 0), 0);
  const creditRows = credits.data?.credits || [];
  const availableCredit = creditRows.reduce((s, c) => s + Number(c.remaining_amount || 0), 0);

  return (
    <div>
      <PageHeader
        title={company.display_name}
        subtitle={company.legal_name && company.legal_name !== company.display_name ? company.legal_name : undefined}
        actions={
          <div className="trailer-actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate?.("rentals", "action=start")}>
              Start a rental
            </button>
            <button type="button" className="btn btn-ghost" onClick={onBack}>Back to companies</button>
          </div>
        }
      />
      <div className="trailer-two-col">
        <Card>
          <h3>Contact</h3>
          <div className="trailer-summary trailer-summary-stack">
            <span>Contact person: {company.contact_name || "—"}</span>
            <span>Phone: {company.phone || "—"}</span>
            <span>Email: {company.email || "—"}</span>
            <span>Payment terms: {company.payment_terms || "—"}</span>
          </div>
        </Card>
        <Card>
          <h3>Money</h3>
          <div className="trailer-summary trailer-summary-stack">
            <span>Outstanding: <b>{usd(outstanding)}</b></span>
            <span>Available company credit: {usd(availableCredit)}</span>
          </div>
        </Card>
      </div>
      <h3>Rentals</h3>
      {rentals.loading ? <div className="loading">Loading…</div>
        : !rentals.data?.items?.length ? <Empty>No rentals with this company yet.</Empty> : (
          <Table
            rows={rentals.data.items}
            columns={[
              { key: "display_number", label: "Rental" },
              { key: "trailer_count", label: "Trailers" },
              { key: "status", label: "Status", render: (r) => rentalStatus(r.status).label },
              { key: "outstanding_amount", label: "Outstanding", render: (r) => usd(r.outstanding_amount) },
            ]}
          />
        )}
      <h3>Invoices</h3>
      {invoices.loading ? <div className="loading">Loading…</div>
        : !invoiceRows.length ? <Empty>No invoices for this company yet.</Empty> : (
          <Table
            rows={invoiceRows}
            columns={[
              { key: "invoice_number", label: "Invoice" },
              { key: "status", label: "Status", render: (r) => invoiceStatus(r.status).label },
              { key: "total_amount", label: "Total", render: (r) => usd(r.total_amount) },
              { key: "outstanding_balance", label: "Outstanding", render: (r) => usd(r.outstanding_balance) },
            ]}
          />
        )}
    </div>
  );
}
