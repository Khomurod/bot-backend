import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { useAuth } from "../../context/AuthContext";
import TrailerCreateDialog from "./TrailerCreateDialog";
import { hasTrailerPermission } from "./trailerNavigation";
import { Alert, Card, Empty, Field, PageHeader, Status, Table, useLoad } from "./TrailerUi";

const COLUMNS = [
  { key: "unit_number", label: "Unit" },
  {
    key: "physical_status",
    label: "Physical status",
    render: (r) => <Status value={r.physical_status} />,
  },
  { key: "display_status", label: "Possession / cargo" },
  { key: "current_company_name", label: "Renter" },
  { key: "current_location_text", label: "Location" },
  { key: "location_source", label: "Source" },
  {
    key: "needs_review",
    label: "Review",
    render: (r) => (r.needs_review ? "Required" : "Verified"),
  },
];

export default function TrailerAssetsPage() {
  const { permissions } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.trailers(), []);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState(null);
  const canCreate = hasTrailerPermission(permissions, "trailers.create");

  const save = async () => {
    try {
      await api.updateTrailer(selected.id, {
        physical_status: selected.physical_status,
        needs_review: selected.needs_review,
        tracking_reference: selected.tracking_reference,
        notes: selected.notes,
      });
      setMsg({ text: "Trailer updated." });
      setSelected(null);
      reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    }
  };

  const created = (trailer) => {
    setAdding(false);
    setMsg({ text: `Trailer ${trailer.unit_number} added.` });
    reload();
  };

  return (
    <div>
      <PageHeader
        title="Trailers"
        subtitle="Physical availability stays separate from possession and cargo."
        actions={
          <>
            {canCreate && (
              <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                Add trailer
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={reload}>
              Refresh
            </button>
          </>
        }
      />
      <Alert message={msg} />
      {error && <div className="alert alert-danger">{error}</div>}
      {loading ? (
        <div className="loading">Loading…</div>
      ) : !data?.trailers?.length ? (
        <Empty />
      ) : (
        <Table rows={data.trailers} onRow={setSelected} columns={COLUMNS} />
      )}
      {adding && <TrailerCreateDialog onClose={() => setAdding(false)} onCreated={created} />}
      {selected && (
        <div className="trailer-modal-backdrop">
          <Card className="trailer-modal">
            <PageHeader
              title={`Trailer ${selected.unit_number}`}
              actions={
                <button type="button" className="btn btn-ghost" onClick={() => setSelected(null)}>
                  Close
                </button>
              }
            />
            <Field label="Physical status">
              <select
                value={selected.physical_status}
                onChange={(e) => setSelected({ ...selected, physical_status: e.target.value })}
              >
                {[
                  "unknown",
                  "available",
                  "rented",
                  "under_inspection",
                  "maintenance",
                  "out_of_service",
                  "held_damage",
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
            <Field label="Tracking reference">
              <input
                value={selected.tracking_reference || ""}
                onChange={(e) => setSelected({ ...selected, tracking_reference: e.target.value })}
              />
            </Field>
            <Field label="Notes">
              <textarea
                value={selected.notes || ""}
                onChange={(e) => setSelected({ ...selected, notes: e.target.value })}
              />
            </Field>
            <label className="trailer-check">
              <input
                type="checkbox"
                checked={!selected.needs_review}
                onChange={(e) => setSelected({ ...selected, needs_review: !e.target.checked })}
              />
              Physical availability verified
            </label>
            <button type="button" className="btn btn-primary" onClick={save}>
              Save trailer
            </button>
          </Card>
        </div>
      )}
    </div>
  );
}
