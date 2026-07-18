import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { useAuth } from "../../context/AuthContext";
import TrailerCreateDialog from "./TrailerCreateDialog";
import TrailerEditDialog from "./TrailerEditDialog";
import { hasTrailerPermission } from "./trailerNavigation";
import { Alert, Empty, PageHeader, Table, useLoad } from "./TrailerUi";
import { trailerCondition } from "./trailerStatusVocabulary";

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

export default function TrailerAssetsPage({ onOpen }) {
  const { permissions } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.trailers(), []);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState(null);
  const canCreate = hasTrailerPermission(permissions, "trailers.create");

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
        <Table rows={data.trailers} onRow={onOpen || setSelected} columns={COLUMNS} />
      )}
      {adding && <TrailerCreateDialog onClose={() => setAdding(false)} onCreated={created} />}
      {selected && (
        <TrailerEditDialog
          trailer={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setMsg({ text: "Trailer updated." });
            setSelected(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
