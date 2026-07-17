import React, { useEffect, useState } from "react";
import api from "../../api/trailerDepartment";
import Inspection from "./TrailerInspectionForm";
import TrailerRentalDraftDialog from "./TrailerRentalDraftDialog";
import ReturnDialog from "./returns/ReturnDialog";
import { Alert, Card, Empty, PageHeader, Status, Table, useLoad } from "./TrailerUi";

function dateIso(value) {
  return value ? new Date(value).toISOString() : null;
}

const EMPTY = {
  trailer_id: "",
  company_id: "",
  start_at: "",
  expected_return_at: "",
  billing_method: "calendar_day",
  daily_rate: "",
  flat_rate: "",
  manual_billable_days: "",
  manual_days_reason: "",
  deposit_amount: "0",
  discount_amount: "0",
  pickup_location: "",
  payment_terms: "",
  notes: "",
};

const COLUMNS = [
  { key: "agreement_number", label: "Agreement" },
  { key: "unit_number", label: "Trailer" },
  { key: "company_name", label: "Company" },
  { key: "status", label: "Status", render: (r) => <Status value={r.status} /> },
  {
    key: "start_at",
    label: "Started",
    render: (r) => (r.start_at ? new Date(r.start_at).toLocaleString() : "—"),
  },
  {
    key: "expected_return_at",
    label: "Expected return",
    render: (r) =>
      r.expected_return_at ? new Date(r.expected_return_at).toLocaleString() : "—",
  },
  {
    key: "outstanding_balance",
    label: "Balance",
    render: (r) => `$${Number(r.outstanding_balance || 0).toFixed(2)}`,
  },
];

export default function TrailerRentalsPage() {
  const list = useLoad(() => api.rentals(), []);
  const assets = useLoad(() => api.trailers({ physicalStatus: "available" }), []);
  const companies = useLoad(() => api.companies({ active: true }), []);
  const [create, setCreate] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [returning, setReturning] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    const warn = (event) => {
      if (create) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [create]);
  const open = async (row) => {
    setSelected(row);
    try {
      setDetail((await api.rental(row.id)).rental);
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    }
  };
  const submitCreate = async (e) => {
    e.preventDefault();
    try {
      await api.createRental({
        ...create,
        start_at: dateIso(create.start_at),
        expected_return_at: dateIso(create.expected_return_at),
        daily_rate: create.daily_rate || null,
        flat_rate: create.flat_rate || null,
        manual_billable_days: create.manual_billable_days
          ? Number(create.manual_billable_days)
          : null,
      });
      setCreate(null);
      setMsg({ text: "Draft rental created." });
      list.reload();
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    }
  };
  // Quick-adds only ever touch their own field: the draft is patched, never replaced.
  const quickAddTrailer = async (unitNumber) => {
    const { trailer } = await api.createTrailer({
      unit_number: unitNumber,
      physical_status: "available",
      needs_review: false,
    });
    await assets.reload();
    setCreate((draft) => ({ ...draft, trailer_id: String(trailer.id) }));
  };
  const quickAddCompany = async (name) => {
    // The backend requires both names; one field is all this flow asks for.
    const { company } = await api.createCompany({ legal_name: name, display_name: name });
    await companies.reload();
    setCreate((draft) => ({ ...draft, company_id: String(company.id) }));
  };
  const activate = async () => {
    try {
      await api.activateRental(detail.id);
      setMsg({ text: "Rental activated and pickup event created." });
      setDetail((await api.rental(detail.id)).rental);
      list.reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    }
  };
  // The return inspection opens the dialog; the dialog collects the inputs the
  // old prompt() pair used to, then calls the same returnRental endpoint.
  const finishReturn = (inspection) =>
    setReturning({ new_damage: Boolean(inspection?.new_damage) });
  const submitReturn = async (payload) => {
    await api.returnRental(detail.id, payload);
    setReturning(null);
    setMsg({ text: "Trailer returned and invoice finalized." });
    setDetail((await api.rental(detail.id)).rental);
    list.reload();
  };
  return (
    <div>
      <PageHeader
        title="Rental Agreements"
        subtitle="Draft, inspect, confirm pickup, return, and invoice without rewriting trailer history."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreate({ ...EMPTY })}
          >
            New rental
          </button>
        }
      />
      <Alert message={msg} />
      {list.error && <div className="alert alert-danger">{list.error}</div>}
      {list.loading ? (
        <div className="loading">Loading…</div>
      ) : !list.data?.rentals?.length ? (
        <Empty>No rental agreements yet.</Empty>
      ) : (
        <Table rows={list.data.rentals} onRow={open} columns={COLUMNS} />
      )}
      {create && (
        <TrailerRentalDraftDialog
          draft={create}
          setDraft={setCreate}
          trailers={assets.data?.trailers || []}
          companies={companies.data?.companies || []}
          onClose={() => setCreate(null)}
          onSubmit={submitCreate}
          onQuickAddTrailer={quickAddTrailer}
          onQuickAddCompany={quickAddCompany}
        />
      )}
      {selected && detail && (
        <div className="trailer-modal-backdrop">
          <Card className="trailer-modal trailer-modal-wide">
            <PageHeader
              title={detail.agreement_number}
              subtitle={`${detail.unit_number} — ${detail.company_name}`}
              actions={
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setSelected(null);
                    setDetail(null);
                  }}
                >
                  Close
                </button>
              }
            />
            <div className="trailer-summary">
              <Status value={detail.status} />
              <span>Billing: {detail.billing_method}</span>
              <span>Rate: ${detail.daily_rate || detail.flat_rate}</span>
            </div>
            {["draft", "scheduled"].includes(detail.status) && (
              <>
                <Inspection
                  rental={detail}
                  type="pickup"
                  onDone={() => setMsg({ text: "Pickup inspection saved." })}
                />
                <button type="button" className="btn btn-primary" onClick={activate}>
                  Confirm pickup and activate
                </button>
              </>
            )}
            {detail.status === "active" && (
              <Inspection rental={detail} type="return" onDone={finishReturn} />
            )}
            {detail.invoices?.map((i) => (
              <Card key={i.id}>
                <b>{i.invoice_number}</b> — ${Number(i.total_amount).toFixed(2)} / balance $
                {Number(i.outstanding_balance).toFixed(2)}
              </Card>
            ))}
          </Card>
        </div>
      )}
      {returning && detail && (
        <ReturnDialog
          rental={detail}
          initialNewDamage={returning.new_damage}
          onClose={() => setReturning(null)}
          onSubmit={submitReturn}
        />
      )}
    </div>
  );
}
