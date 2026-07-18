import React, { useEffect, useState } from "react";
import api from "../../api/trailerDepartment";
import { useAuth } from "../../context/AuthContext";
import TrailerCreateDialog from "./TrailerCreateDialog";
import TrailerEditDialog from "./TrailerEditDialog";
import { hasTrailerPermission } from "./trailerNavigation";
import { Alert, Empty, Field, PageHeader, Pagination, Table, useLoad, useUrlList } from "./TrailerUi";
import { trailerCondition } from "./trailerStatusVocabulary";

const FILTER_KEYS = ["q", "physicalStatus", "rental_state", "company", "missing_location", "needs_attention", "page", "page_size"];
const CONDITIONS = ["available", "rented", "under_inspection", "maintenance", "out_of_service", "held_damage", "unknown"];

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
  const { filters, setFilter, setPage, clearAll, activeCount } = useUrlList(FILTER_KEYS);
  // Debounced text search: type freely, the query fires 300ms after the last keystroke.
  const [searchText, setSearchText] = useState(filters.q || "");
  useEffect(() => {
    const id = setTimeout(() => {
      if ((searchText || "") !== (filters.q || "")) setFilter({ q: searchText || undefined });
    }, 300);
    return () => clearTimeout(id);
  }, [searchText]);

  const { data, loading, error, reload } = useLoad(
    () => api.trailers(filters),
    [JSON.stringify(filters)],
  );
  const rows = data?.items || data?.trailers || [];
  const total = data?.total ?? rows.length;
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
      <div className="trailer-filter-bar" role="search">
        <Field label="Search">
          <input type="search" value={searchText} placeholder="Unit, VIN, plate, company or location"
            aria-label="Search trailers"
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setFilter({ q: searchText || undefined }); }} />
        </Field>
        <Field label="Condition">
          <select value={filters.physicalStatus || ""} onChange={(e) => setFilter({ physicalStatus: e.target.value || undefined })}>
            <option value="">Any condition</option>
            {CONDITIONS.map((c) => <option key={c} value={c}>{trailerCondition(c).label}</option>)}
          </select>
        </Field>
        <Field label="Rental state">
          <select value={filters.rental_state || ""} onChange={(e) => setFilter({ rental_state: e.target.value || undefined })}>
            <option value="">Any</option>
            <option value="available">Available</option>
            <option value="rented">Rented</option>
          </select>
        </Field>
        <Field label="Company">
          <input value={filters.company || ""} placeholder="Company name"
            onChange={(e) => setFilter({ company: e.target.value || undefined })} />
        </Field>
        <label className="trailer-check">
          <input type="checkbox" checked={filters.missing_location === "true" || filters.missing_location === true}
            onChange={(e) => setFilter({ missing_location: e.target.checked ? "true" : undefined })} />
          Missing location
        </label>
        <label className="trailer-check">
          <input type="checkbox" checked={filters.needs_attention === "true" || filters.needs_attention === true}
            onChange={(e) => setFilter({ needs_attention: e.target.checked ? "true" : undefined })} />
          Needs attention
        </label>
        {activeCount > 0 && (
          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => { setSearchText(""); clearAll(); }}>
            Clear all filters ({activeCount})
          </button>
        )}
      </div>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {loading ? (
        <div className="loading" role="status">Loading…</div>
      ) : !rows.length ? (
        <Empty>{activeCount > 0
          ? "No trailers match these filters. Try clearing them."
          : "No trailers yet."}</Empty>
      ) : (
        <>
          <Table rows={rows} onRow={onOpen || setSelected} columns={COLUMNS} />
          <Pagination page={filters.page} pageSize={filters.page_size} total={total} onPage={setPage} />
        </>
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
