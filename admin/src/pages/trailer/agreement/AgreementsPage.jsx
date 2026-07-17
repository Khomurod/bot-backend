import React, { useState } from "react";
import api from "../../../api/trailerAgreements";
import dept from "../../../api/trailerDepartment";
import { Alert, Empty, Field, PageHeader, Status, Table, useLoad } from "../TrailerUi";
import { AGREEMENT_STATUSES, money } from "./agreementConstants";
import AgreementBuilder from "./AgreementBuilder";
import AgreementDetail from "./AgreementDetail";

const PAGE_SIZE = 25;

const COLUMNS = [
  { key: "agreement_number", label: "Agreement" },
  { key: "status", label: "Status", render: (r) => <Status value={r.status} /> },
  { key: "pricing_mode", label: "Pricing" },
  {
    key: "current_agreed_amount",
    label: "Agreed",
    render: (r) => money(r.current_agreed_amount),
  },
  {
    key: "created_at",
    label: "Created",
    render: (r) => (r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"),
  },
];

export default function AgreementsPage() {
  const [view, setView] = useState({ name: "list" });
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState(null);

  const list = useLoad(
    () => api.listAgreements({ status, page, pageSize: PAGE_SIZE }),
    [status, page],
  );
  const companies = useLoad(() => dept.companies({ active: true }), []);
  const assets = useLoad(() => dept.trailers(), []);

  const companyList = companies.data?.companies || [];
  const trailerList = assets.data?.trailers || [];

  if (view.name === "builder") {
    return (
      <AgreementBuilder
        companies={companyList}
        trailers={trailerList}
        onCancel={() => setView({ name: "list" })}
        onCreated={(agreement) => {
          setMsg({ text: `Draft ${agreement.agreement_number} created.` });
          list.reload();
          setView({ name: "detail", id: agreement.id });
        }}
      />
    );
  }

  if (view.name === "detail") {
    return (
      <AgreementDetail
        agreementId={view.id}
        trailers={trailerList}
        onBack={() => {
          list.reload();
          setView({ name: "list" });
        }}
      />
    );
  }

  const total = list.data?.total || 0;
  const items = list.data?.items || [];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Agreements"
        subtitle="Multi-trailer rental agreements — draft, schedule, activate, return, and invoice."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setView({ name: "builder" })}
          >
            New agreement
          </button>
        }
      />
      <Alert message={msg} />
      <div style={{ maxWidth: 260 }}>
        <Field label="Status filter">
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
          >
            <option value="">All statuses</option>
            {AGREEMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {list.error && <div className="alert alert-danger">{list.error}</div>}
      {list.loading ? (
        <div className="loading">Loading…</div>
      ) : !items.length ? (
        <Empty>No agreements found.</Empty>
      ) : (
        <>
          <Table
            rows={items}
            columns={COLUMNS}
            onRow={(row) => setView({ name: "detail", id: row.id })}
          />
          <div className="trailer-actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span>
              Page {page} of {pageCount} ({total} total)
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
