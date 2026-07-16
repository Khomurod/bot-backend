import React, { useEffect, useState } from "react";
import api from "../../api/trailerDepartment";
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
const INSPECTION_FIELDS = [
  "overall_condition",
  "tires",
  "lights",
  "doors",
  "roof",
  "floor",
  "exterior",
  "interior",
  "landing_gear",
  "brakes",
  "existing_damage",
  "new_damage",
  "missing_equipment",
  "notes",
];
function dateIso(value) {
  return value ? new Date(value).toISOString() : null;
}
function Inspection({ rental, type, onDone }) {
  const [form, setForm] = useState(Object.fromEntries(INSPECTION_FIELDS.map((key) => [
    key, ["brakes", "existing_damage", "new_damage", "missing_equipment", "notes"].includes(key) ? "" : "Good",
  ])));
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const { inspection } = await api.saveInspection(rental.id, type, {
        ...form,
        completed: true,
      });
      if (!files.length)
        throw new Error("Select at least one condition photo.");
      await api.uploadMedia(files, {
        media_type:
          type === "pickup"
            ? "pickup_condition_photo"
            : "return_condition_photo",
        rental_id: rental.id,
        trailer_id: rental.trailer_id,
        inspection_id: inspection.id,
      });
      onDone?.(inspection);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <h3>{type === "pickup" ? "Pickup" : "Return"} inspection</h3>
      <div className="trailer-form-grid">
        {INSPECTION_FIELDS.map((key) => (
          <Field key={key} label={key.replaceAll("_", " ")}>
            <input
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </Field>
        ))}
        <Field label="Condition photos">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={(e) => setFiles([...e.target.files])}
          />
        </Field>
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>
        {busy ? "Processing…" : "Complete inspection and upload"}
      </button>
    </Card>
  );
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
export default function TrailerRentalsPage() {
  const list = useLoad(() => api.rentals(), []);
  const assets = useLoad(
    () => api.trailers({ physicalStatus: "available" }),
    [],
  );
  const companies = useLoad(() => api.companies({ active: true }), []);
  const [create, setCreate] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    const warn = (event) => { if (create) { event.preventDefault(); event.returnValue = ""; } };
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
        manual_billable_days: create.manual_billable_days ? Number(create.manual_billable_days) : null,
      });
      setCreate(null);
      setMsg({ text: "Draft rental created." });
      list.reload();
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    }
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
  const finishReturn = async (inspection) => {
    const location = prompt("Return location");
    if (!location) return;
    const physical = prompt(
      "Status after return: available, under_inspection, maintenance, out_of_service, held_damage",
      "available",
    );
    try {
      await api.returnRental(detail.id, {
        actual_return_at: new Date().toISOString(),
        return_location: location,
        physical_status: physical,
        damage_charge: 0,
        cleaning_charge: 0,
        other_charges: 0,
        new_damage: inspection.new_damage,
      });
      setMsg({ text: "Trailer returned and invoice finalized." });
      setDetail((await api.rental(detail.id)).rental);
      list.reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    }
  };
  return (
    <div>
      <PageHeader
        title="Rental Agreements"
        subtitle="Draft, inspect, confirm pickup, return, and invoice without rewriting trailer history."
        actions={
          <button
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
        <Table
          rows={list.data.rentals}
          onRow={open}
          columns={[
            { key: "agreement_number", label: "Agreement" },
            { key: "unit_number", label: "Trailer" },
            { key: "company_name", label: "Company" },
            {
              key: "status",
              label: "Status",
              render: (r) => <Status value={r.status} />,
            },
            {
              key: "start_at",
              label: "Started",
              render: (r) =>
                r.start_at ? new Date(r.start_at).toLocaleString() : "—",
            },
            {
              key: "expected_return_at",
              label: "Expected return",
              render: (r) =>
                r.expected_return_at
                  ? new Date(r.expected_return_at).toLocaleString()
                  : "—",
            },
            {
              key: "outstanding_balance",
              label: "Balance",
              render: (r) =>
                `$${Number(r.outstanding_balance || 0).toFixed(2)}`,
            },
          ]}
        />
      )}{" "}
      {create && (
        <div className="trailer-modal-backdrop">
          <Card className="trailer-modal trailer-modal-wide">
            <PageHeader
              title="New rental draft"
              actions={
                <button
                  className="btn btn-ghost"
                  onClick={() => setCreate(null)}
                >
                  Close
                </button>
              }
            />
            <form onSubmit={submitCreate} className="trailer-form-grid">
              <Field label="Available trailer">
                <select
                  required
                  value={create.trailer_id}
                  onChange={(e) =>
                    setCreate({ ...create, trailer_id: e.target.value })
                  }
                >
                  <option value="">Select…</option>
                  {assets.data?.trailers?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.unit_number}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Renter company">
                <select
                  required
                  value={create.company_id}
                  onChange={(e) =>
                    setCreate({ ...create, company_id: e.target.value })
                  }
                >
                  <option value="">Select…</option>
                  {companies.data?.companies?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Pickup date/time">
                <input
                  required
                  type="datetime-local"
                  value={create.start_at}
                  onChange={(e) =>
                    setCreate({ ...create, start_at: e.target.value })
                  }
                />
              </Field>
              <Field label="Expected return">
                <input
                  required
                  type="datetime-local"
                  value={create.expected_return_at}
                  onChange={(e) =>
                    setCreate({ ...create, expected_return_at: e.target.value })
                  }
                />
              </Field>
              <Field label="Billing method">
                <select
                  value={create.billing_method}
                  onChange={(e) =>
                    setCreate({ ...create, billing_method: e.target.value })
                  }
                >
                  {[
                    "calendar_day",
                    "twenty_four_hour",
                    "manual_days",
                    "flat_rate",
                  ].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
              {create.billing_method === "flat_rate" ? <Field label="Flat rate"><input required type="number" min="0" step="0.01" value={create.flat_rate} onChange={(e) => setCreate({ ...create, flat_rate: e.target.value })}/></Field>
                : <Field label="Daily rate"><input required type="number" min="0" step="0.01" value={create.daily_rate} onChange={(e) => setCreate({ ...create, daily_rate: e.target.value })}/></Field>}
              {create.billing_method === "manual_days" && <><Field label="Agreed billable days"><input required type="number" min="1" step="1" value={create.manual_billable_days} onChange={(e) => setCreate({ ...create, manual_billable_days: e.target.value })}/></Field><Field label="Manual-day reason"><input required value={create.manual_days_reason} onChange={(e) => setCreate({ ...create, manual_days_reason: e.target.value })}/></Field></>}
              <Field label="Pickup location">
                <input
                  required
                  value={create.pickup_location}
                  onChange={(e) =>
                    setCreate({ ...create, pickup_location: e.target.value })
                  }
                />
              </Field>
              <Field label="Notes">
                <textarea
                  value={create.notes}
                  onChange={(e) =>
                    setCreate({ ...create, notes: e.target.value })
                  }
                />
              </Field>
              <button className="btn btn-primary" type="submit">
                Save draft
              </button>
            </form>
          </Card>
        </div>
      )}{" "}
      {selected && detail && (
        <div className="trailer-modal-backdrop">
          <Card className="trailer-modal trailer-modal-wide">
            <PageHeader
              title={detail.agreement_number}
              subtitle={`${detail.unit_number} — ${detail.company_name}`}
              actions={
                <button
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
                <button className="btn btn-primary" onClick={activate}>
                  Confirm pickup and activate
                </button>
              </>
            )}
            {detail.status === "active" && (
              <Inspection rental={detail} type="return" onDone={finishReturn} />
            )}{" "}
            {detail.invoices?.map((i) => (
              <Card key={i.id}>
                <b>{i.invoice_number}</b> — ${Number(i.total_amount).toFixed(2)}{" "}
                / balance ${Number(i.outstanding_balance).toFixed(2)}
              </Card>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
