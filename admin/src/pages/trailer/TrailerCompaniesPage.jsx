import React, { useEffect, useState } from "react";
import api from "../../api/trailerDepartment";
import { Alert, Card, Empty, Field, Modal, PageHeader, Pagination, Table, useLoad, useUrlList } from "./TrailerUi";
import { invoiceStatus, rentalStatus } from "./trailerStatusVocabulary";
import CompanyDetail from "./TrailerCompanyDetail";
import { EMPTY, FIELD_LABELS } from "./companyFields";

const COMPANY_FILTER_KEYS = ["q", "active", "page", "page_size"];

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

export default function TrailerCompaniesPage({ navigate }) {
  const { filters, setFilter, setPage, clearAll, activeCount } = useUrlList(COMPANY_FILTER_KEYS);
  const [searchText, setSearchText] = useState(filters.q || "");
  useEffect(() => {
    const id = setTimeout(() => {
      if ((searchText || "") !== (filters.q || "")) setFilter({ q: searchText || undefined });
    }, 300);
    return () => clearTimeout(id);
  }, [searchText]);

  const { data, loading, error, reload } = useLoad(() => api.companies(filters), [JSON.stringify(filters)]);
  const rows = data?.items || data?.companies || [];
  const total = data?.total ?? rows.length;
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
      <div className="trailer-filter-bar" role="search">
        <Field label="Search">
          <input type="search" value={searchText} aria-label="Search companies"
            placeholder="Company name, MC or DOT number"
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setFilter({ q: searchText || undefined }); }} />
        </Field>
        <Field label="Status">
          <select value={filters.active || ""} onChange={(e) => setFilter({ active: e.target.value || undefined })}>
            <option value="">All companies</option>
            <option value="true">Active</option>
            <option value="false">Archived</option>
          </select>
        </Field>
        {activeCount > 0 && (
          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => { setSearchText(""); clearAll(); }}>Clear all filters ({activeCount})</button>
        )}
      </div>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {loading ? (
        <div className="loading" role="status"><div className="spinner" />Loading…</div>
      ) : !rows.length ? (
        <Card>
          <Empty>{activeCount > 0
            ? "No companies match these filters. Try clearing them."
            : "No companies yet. Add the first company to start renting trailers."}</Empty>
          <button type="button" className="btn btn-primary" onClick={() => setForm({ ...EMPTY })}>Add company</button>
        </Card>
      ) : (
        <>
        <Table
          rows={rows}
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
        <Pagination page={filters.page} pageSize={filters.page_size} total={total} onPage={setPage} />
        </>
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
