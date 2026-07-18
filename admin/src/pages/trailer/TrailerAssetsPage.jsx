import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { useAuth } from "../../context/AuthContext";
import TrailerCreateDialog from "./TrailerCreateDialog";
import { hasTrailerPermission } from "./trailerNavigation";
import { Alert, Card, Empty, Field, PageHeader, Table, useLoad } from "./TrailerUi";
import { TRAILER_CONDITION_LABELS, trailerCondition } from "./trailerStatusVocabulary";

const SOURCE_LABELS = { manual: "Manual", ai: "Driver-derived", geocoded: "Driver-derived", gps: "GPS" };

const COLUMNS = [
  { key: "unit_number", label: "Trailer" },
  {
    key: "physical_status",
    label: "Condition",
    render: (r) => {
      const s = trailerCondition(r.physical_status);
      return <span className={`trailer-pill trailer-pill-${s.tone}`}>{s.label}</span>;
    },
  },
  { key: "current_company_name", label: "Rented to", render: (r) => r.current_company_name || "—" },
  {
    key: "expected_return_at",
    label: "Expected back",
    render: (r) => (r.expected_return_at ? new Date(r.expected_return_at).toLocaleDateString() : "—"),
  },
  { key: "current_location_text", label: "Last known location", render: (r) => r.current_location_text || "—" },
  {
    key: "location_source",
    label: "Location source",
    render: (r) => (r.current_location_text ? SOURCE_LABELS[r.location_source] || "Unknown" : "Unknown"),
  },
  { key: "display_status", label: "Loaded or empty", render: (r) => r.display_status || "—" },
  {
    key: "needs_review",
    label: "",
    render: (r) => (r.needs_review ? <span className="trailer-pill trailer-pill-attention">Needs attention</span> : null),
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
        version: selected.version,
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
        subtitle="Every trailer with its condition, current renter and last known location."
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
            <Field label="Trailer condition">
              <select
                value={selected.physical_status}
                onChange={(e) => setSelected({ ...selected, physical_status: e.target.value })}
              >
                {Object.entries(TRAILER_CONDITION_LABELS).map(([value, s]) => (
                  <option key={value} value={value}>{s.label}</option>
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
