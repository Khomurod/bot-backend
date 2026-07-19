import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { Alert, Card, Empty, Field, Modal, PageHeader, Table, useLoad } from "./TrailerUi";
import { invoiceStatus, rentalStatus } from "./trailerStatusVocabulary";
import { EMPTY, FIELD_LABELS } from "./companyFields";

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

/** Edit-company dialog: same fields as create, with optimistic locking. */
function EditCompanyDialog({ company, onClose, onSaved }) {
  const [form, setForm] = useState(() => Object.fromEntries(
    Object.keys(EMPTY).map((k) => [k, company[k] ?? ""]),
  ));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      // Send the current version so a concurrent edit is a 409, not an overwrite.
      await api.updateCompany(company.id, { ...form, version: company.version });
      onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title={`Edit ${company.display_name}`} onClose={busy ? undefined : onClose}>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
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
    </Modal>
  );
}

export default function CompanyDetail({ company, navigate, onBack }) {
  const rentals = useLoad(() => api.rentalList({ company_id: company.id, page_size: 50 }), [company.id]);
  const invoices = useLoad(() => api.invoices({ companyId: company.id }), [company.id]);
  const credits = useLoad(() => api.companyCredits(company.id), [company.id]);
  const documents = useLoad(() => api.companyMedia(company.id), [company.id]);
  const reminders = useLoad(() => api.companyReminderHistory(company.id), [company.id]);
  const auditLog = useLoad(() => api.audit({ entityType: "company", entityId: company.id }), [company.id]);
  const [editing, setEditing] = useState(false);
  const [busyDoc, setBusyDoc] = useState(null);
  const [msg, setMsg] = useState(null);

  // A short-lived signed URL is requested only at click time, never in the list.
  const openDocument = async (row, preview) => {
    setBusyDoc(row.id);
    try {
      const { url } = await api.mediaSignedUrl(row.id, { preview });
      window.open(url, "_blank", "noopener");
    } catch (e) { setMsg({ type: "error", text: e.message }); } finally { setBusyDoc(null); }
  };

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
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
              Edit company
            </button>
            <button type="button" className="btn btn-ghost" onClick={onBack}>Back to companies</button>
          </div>
        }
      />
      <Alert message={msg} />
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
            onRow={(r) => navigate?.("rentals", `rental=${r.agreement_id}`)}
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
            onRow={(r) => navigate?.("money", `invoice=${r.id}`)}
            columns={[
              { key: "invoice_number", label: "Invoice" },
              { key: "status", label: "Status", render: (r) => invoiceStatus(r.status).label },
              { key: "total_amount", label: "Total", render: (r) => usd(r.total_amount) },
              { key: "outstanding_balance", label: "Outstanding", render: (r) => usd(r.outstanding_balance) },
            ]}
          />
        )}
      <h3>Company credits</h3>
      {credits.loading ? <div className="loading">Loading…</div>
        : !creditRows.length ? <Empty>No company credits. An authorized overpayment creates one.</Empty> : (
          <Table
            rows={creditRows}
            columns={[
              { key: "created_at", label: "Created", render: (r) => (r.created_at ? new Date(r.created_at).toLocaleDateString() : "—") },
              { key: "original_amount", label: "Original", render: (r) => usd(r.original_amount) },
              { key: "remaining_amount", label: "Remaining", render: (r) => usd(r.remaining_amount) },
              { key: "status", label: "Status" },
              { key: "reason", label: "Reason", render: (r) => r.reason || "—" },
            ]}
          />
        )}
      <h3>Documents</h3>
      {documents.loading ? <div className="loading">Loading…</div>
        : !(documents.data?.media || []).length ? <Empty>No documents yet. Receipts and photos appear here as rentals happen.</Empty> : (
          <Table
            rows={documents.data.media}
            columns={[
              { key: "media_type", label: "Type", render: (r) => String(r.media_type || "").replaceAll("_", " ") },
              { key: "original_filename", label: "File" },
              { key: "created_at", label: "Uploaded", render: (r) => (r.created_at ? new Date(r.created_at).toLocaleString() : "—") },
              { key: "uploaded_by", label: "By", render: (r) => r.uploaded_by || "—" },
              {
                key: "actions",
                label: "",
                render: (r) => (
                  <span className="trailer-actions">
                    <button type="button" className="btn btn-sm btn-secondary" disabled={busyDoc === r.id}
                      onClick={(e) => { e.stopPropagation(); openDocument(r, true); }}>Preview</button>
                    <button type="button" className="btn btn-sm btn-secondary" disabled={busyDoc === r.id}
                      onClick={(e) => { e.stopPropagation(); openDocument(r, false); }}>Download</button>
                  </span>
                ),
              },
            ]}
          />
        )}
      <h3>Reminder history</h3>
      {reminders.loading ? <div className="loading">Loading…</div>
        : !(reminders.data?.history || []).length ? <Empty>No reminder activity for this company yet.</Empty> : (
          <Table
            rows={reminders.data.history}
            columns={[
              { key: "action_at", label: "When", render: (r) => (r.action_at ? new Date(r.action_at).toLocaleString() : "—") },
              { key: "invoice_number", label: "Invoice" },
              { key: "action", label: "What happened", render: (r) => String(r.action || "").replaceAll("_", " ") },
              { key: "action_by", label: "By", render: (r) => r.action_by || "system" },
              { key: "note", label: "Note", render: (r) => r.note || "—" },
            ]}
          />
        )}
      <h3>Change history</h3>
      {auditLog.loading ? <div className="loading">Loading…</div>
        : !(auditLog.data?.audit || []).length ? <Empty>No recorded changes to this company yet.</Empty> : (
          (auditLog.data.audit || []).slice(0, 20).map((row) => (
            <div key={row.id} className="trailer-activity-row">
              <span>{String(row.action || "").replaceAll(".", " ").replaceAll("_", " ")}
                {row.username ? ` — by ${row.username}` : ""}{row.reason ? ` (${row.reason})` : ""}</span>
              <span className="trailer-attention-age">{row.created_at ? new Date(row.created_at).toLocaleString() : ""}</span>
            </div>
          ))
        )}
      {editing && (
        <EditCompanyDialog
          company={company}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setMsg({ text: `${company.display_name} updated. Reopen the company to see the changes.` });
          }}
        />
      )}
    </div>
  );
}
