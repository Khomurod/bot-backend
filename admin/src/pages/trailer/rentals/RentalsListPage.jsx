import React, { useCallback, useEffect, useState } from "react";
import dept from "../../../api/trailerDepartment";
import { Card, PageHeader } from "../TrailerUi";
import { rentalStatus } from "../trailerStatusVocabulary";

const TABS = [
  { key: "needs_attention", label: "Needs attention" },
  { key: "upcoming_pickups", label: "Upcoming pickups" },
  { key: "currently_rented", label: "Currently rented" },
  { key: "returns", label: "Returns" },
  { key: "completed", label: "Completed" },
  { key: "all", label: "All" },
];

const EMPTY_COPY = {
  needs_attention: "Nothing needs attention — every rental is on track.",
  upcoming_pickups: "No pickups are planned yet.",
  currently_rented: "No trailers are rented out right now.",
  returns: "No rentals are waiting on a return.",
  completed: "No completed rentals yet.",
  all: "No rentals yet.",
};

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const day = (d) => (d ? new Date(d).toLocaleDateString() : "—");

/** Read list state from the URL so filters survive reload and are shareable. */
function readParams() {
  const p = new URLSearchParams(window.location.search);
  return { tab: p.get("tab") || "all", q: p.get("q") || "", page: Number(p.get("page")) || 1 };
}

function writeParams(next) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(next)) {
    if (v && v !== "" && !(k === "page" && v === 1)) url.searchParams.set(k, v);
    else url.searchParams.delete(k);
  }
  window.history.replaceState({}, "", url);
}

function StatusPill({ status }) {
  const s = rentalStatus(status);
  return <span className={`trailer-pill trailer-pill-${s.tone}`}>{s.label}</span>;
}

/**
 * The ONE rentals list: server-paginated over the unified read model, with
 * plain-language statuses and a next-action button per row.
 */
export default function RentalsListPage({ onOpen, onStart, canManage }) {
  const [params, setParams] = useState(readParams);
  const [search, setSearch] = useState(params.q);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p) => {
    setLoading(true);
    setError("");
    try {
      setData(await dept.rentalList({ tab: p.tab === "all" ? "" : p.tab, q: p.q, page: p.page }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(params); }, [params, load]);

  const update = (patch) => {
    const next = { ...params, page: 1, ...patch };
    writeParams(next);
    setParams(next);
  };

  return (
    <div>
      <PageHeader
        title="Rentals"
        subtitle="Every rental in one place — from setup to pickup, return and payment."
        actions={canManage && (
          <button type="button" className="btn btn-primary" onClick={onStart}>Start a rental</button>
        )}
      />
      <div className="trailer-section-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={params.tab === t.key}
            className={`trailer-section-tab ${params.tab === t.key ? "active" : ""}`}
            onClick={() => update({ tab: t.key })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <form
        className="trailer-list-controls"
        onSubmit={(e) => { e.preventDefault(); update({ q: search }); }}
      >
        <label htmlFor="rental-search" className="sr-only">Search rentals</label>
        <input
          id="rental-search"
          placeholder="Search by number, company, trailer or invoice"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="submit" className="btn btn-secondary">Search</button>
        {params.q && (
          <button type="button" className="btn btn-ghost" onClick={() => { setSearch(""); update({ q: "" }); }}>
            Clear
          </button>
        )}
      </form>
      {error && <div className="alert alert-danger">{error}</div>}
      {loading && <div className="loading"><div className="spinner" />Loading…</div>}
      {!loading && !data?.items?.length && (
        <Card>
          <p className="trailer-empty-line">{EMPTY_COPY[params.tab] || EMPTY_COPY.all}</p>
          {canManage && (
            <button type="button" className="btn btn-primary" onClick={onStart}>Start a rental</button>
          )}
        </Card>
      )}
      {!loading && data?.items?.map((r) => (
        <button
          key={r.id}
          type="button"
          className="trailer-rental-row"
          onClick={() => onOpen(r.agreement_id)}
        >
          <div className="trailer-rental-row-main">
            <strong>{r.company.name}</strong>
            <span>
              {r.trailer_count === 1
                ? `Trailer ${r.trailers[0]?.unit_number || ""}`
                : `${r.trailer_count} trailers`}
              {" · "}{r.display_number}
            </span>
          </div>
          <div className="trailer-rental-row-dates">
            <span>Pickup {day(r.pickup_at)}</span>
            <span>Return {day(r.expected_return_at)}</span>
          </div>
          <StatusPill status={r.status} />
          <div className="trailer-rental-row-end">
            {Number(r.outstanding_amount) > 0 && (
              <span className="trailer-outstanding">{usd(r.outstanding_amount)} outstanding</span>
            )}
            {r.next_action?.label && (
              <span className={`trailer-next-action ${r.next_action.urgent ? "urgent" : ""}`}>
                {r.next_action.label}
              </span>
            )}
          </div>
        </button>
      ))}
      {!loading && data && data.total > data.page_size && (
        <div className="trailer-pager">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={params.page <= 1}
            onClick={() => update({ page: params.page - 1 })}
          >
            Previous
          </button>
          <span>Page {data.page} of {Math.ceil(data.total / data.page_size)}</span>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={data.page * data.page_size >= data.total}
            onClick={() => update({ page: params.page + 1 })}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
