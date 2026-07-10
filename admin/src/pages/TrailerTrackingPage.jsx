import React, { useEffect, useState, useCallback, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as api from "../api";

const TABS = [
  { key: "list", label: "Trailer List" },
  { key: "import", label: "Upload / Import" },
  { key: "events", label: "Events History" },
  { key: "unidentified", label: "Unidentified" },
  { key: "map", label: "Map / Locations" },
  { key: "settings", label: "Settings" },
];

const STATUS_LABEL = {
  with_driver: "With driver",
  dropped: "Dropped",
  unknown: "Unknown",
};
const STATUS_COLOR = {
  with_driver: "#22c55e",
  dropped: "#f59e0b",
  unknown: "#94a3b8",
};

function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

function StatusBadge({ status, needsReview }) {
  const s = status || "unknown";
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 12,
      background: STATUS_COLOR[s] + "22", color: STATUS_COLOR[s], fontWeight: 600,
    }}>
      {STATUS_LABEL[s] || s}{needsReview ? " • review" : ""}
    </span>
  );
}

// ─── Trailer List tab ───
function TrailerListTab({ onOpen, flash }) {
  const [trailers, setTrailers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ q: "", status: "", needs_review: false });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getTrailers({
        q: filters.q || undefined,
        status: filters.status || undefined,
        needs_review: filters.needs_review ? "true" : undefined,
      });
      setTrailers(data.trailers || []);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setLoading(false);
    }
  }, [filters, flash]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input
          className="form-input" placeholder="Search unit / plate / VIN" style={{ maxWidth: 240 }}
          value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
        />
        <select className="form-input" style={{ maxWidth: 160 }}
          value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>
          <option value="with_driver">With driver</option>
          <option value="dropped">Dropped</option>
          <option value="unknown">Unknown</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={filters.needs_review}
            onChange={(e) => setFilters((f) => ({ ...f, needs_review: e.target.checked }))} />
          Needs review
        </label>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {loading ? <p>Loading…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Unit</th><th>Status</th><th>Current Driver</th><th>Location</th>
                <th>Last Condition</th><th>Last Event</th><th>Plate</th><th>VIN</th>
                <th>Type</th><th>Ownership</th><th>Last Reporter</th><th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {trailers.length === 0 && (
                <tr><td colSpan={12} style={{ textAlign: "center", color: "#94a3b8" }}>No trailers yet.</td></tr>
              )}
              {trailers.map((t) => (
                <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => onOpen(t.id)}>
                  <td><strong>{t.unit_number}</strong></td>
                  <td><StatusBadge status={t.current_status} needsReview={t.needs_review} /></td>
                  <td>{t.current_driver_name || "—"}</td>
                  <td>{t.current_location_text || "—"}</td>
                  <td>{t.current_condition || "—"}</td>
                  <td>{t.last_event_type || "—"}</td>
                  <td>{t.plate_number || "—"}</td>
                  <td>{t.vin || "—"}</td>
                  <td>{t.type || "—"}</td>
                  <td>{t.ownership_status || "—"}</td>
                  <td>{t.last_reporter_name || "—"}</td>
                  <td>{fmtTime(t.last_event_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Import tab ───
function ImportTab({ flash }) {
  const [files, setFiles] = useState([]);
  const [rows, setRows] = useState(null);
  const [batchId, setBatchId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [batches, setBatches] = useState([]);

  const loadBatches = useCallback(async () => {
    try { const d = await api.getTrailerImportBatches(); setBatches(d.batches || []); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadBatches(); }, [loadBatches]);

  const parse = async () => {
    if (!files.length) { flash("error", "Choose at least one image."); return; }
    setBusy(true);
    try {
      const d = await api.importTrailerScreenshot(files);
      setBatchId(d.batch.id);
      setRows((d.rows || []).map((r) => ({ ...r, _include: true })));
      flash("success", `Parsed ${d.rows?.length || 0} rows. Review before committing.`);
    } catch (err) {
      flash("error", err.message);
    } finally { setBusy(false); }
  };

  const setCell = (i, k, v) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));

  const commit = async () => {
    const include = (rows || []).filter((r) => r._include && r.unit_number);
    if (!include.length) { flash("error", "No rows with a unit number selected."); return; }
    setBusy(true);
    try {
      const d = await api.commitTrailerImport(batchId, include);
      flash("success", `Imported: ${d.summary.created} created, ${d.summary.updated} updated, ${d.summary.skipped} skipped.`);
      setRows(null); setBatchId(null); setFiles([]);
      loadBatches();
    } catch (err) {
      flash("error", err.message);
    } finally { setBusy(false); }
  };

  const COLS = ["unit_number", "make", "model", "mc_number", "plate_number", "type", "vin", "year", "ownership_status"];

  return (
    <div>
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h3>Upload trailer list screenshot</h3>
        <p style={{ color: "#94a3b8" }}>PNG / JPG / WebP, up to 10 MB each. AI reads each row; review before importing. Blank fields never overwrite existing trailer data.</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple
            onChange={(e) => setFiles(Array.from(e.target.files || []))} />
          <button className="btn btn-primary" onClick={parse} disabled={busy || !files.length}>
            {busy ? "Reading…" : "Read screenshot"}
          </button>
        </div>
      </div>

      {rows && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <h3>Parsed preview — edit before importing</h3>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr><th>✓</th>{COLS.map((c) => <th key={c}>{c.replace(/_/g, " ")}</th>)}<th>review</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={r.needs_review ? { background: "#f59e0b18" } : undefined}>
                    <td><input type="checkbox" checked={!!r._include} onChange={(e) => setCell(i, "_include", e.target.checked)} /></td>
                    {COLS.map((c) => (
                      <td key={c}>
                        <input className="form-input" style={{ minWidth: 90, padding: "2px 6px" }}
                          value={r[c] || ""} onChange={(e) => setCell(i, c, e.target.value)} />
                      </td>
                    ))}
                    <td>{r.needs_review ? "⚠️" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={commit} disabled={busy}>Commit import</button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 16 }}>
        <h3>Import history</h3>
        <table className="data-table">
          <thead><tr><th>When</th><th>File</th><th>By</th><th>Status</th><th>Rows</th><th>Review</th></tr></thead>
          <tbody>
            {batches.length === 0 && <tr><td colSpan={6} style={{ color: "#94a3b8" }}>No imports yet.</td></tr>}
            {batches.map((b) => (
              <tr key={b.id}>
                <td>{fmtTime(b.created_at)}</td><td>{b.file_name || "—"}</td><td>{b.uploaded_by || "—"}</td>
                <td>{b.status}</td><td>{b.parsed_count}</td><td>{b.error_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Events tab ───
function EventsTab({ flash }) {
  const [events, setEvents] = useState([]);
  const [type, setType] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.getTrailerEvents({ event_type: type || undefined }); setEvents(d.events || []); }
    catch (err) { flash("error", err.message); }
    finally { setLoading(false); }
  }, [type, flash]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <select className="form-input" style={{ maxWidth: 180 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All event types</option>
          <option value="pickup">Pickup</option>
          <option value="dropoff">Drop-off</option>
          <option value="mention_only">Mention only</option>
          <option value="unidentified">Unidentified</option>
        </select>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {loading ? <p>Loading…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead><tr><th>When</th><th>Type</th><th>Unit</th><th>Group</th><th>Driver</th><th>Location</th><th>Condition</th><th>Reporter</th><th>Conf</th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={9} style={{ color: "#94a3b8" }}>No events.</td></tr>}
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{fmtTime(e.event_time || e.created_at)}</td>
                  <td>{e.event_type}</td>
                  <td><strong>{e.trailer_unit_number || "—"}</strong></td>
                  <td>{e.telegram_group_name || "—"}</td>
                  <td>{e.driver_name || "—"}</td>
                  <td>{e.location_text || (e.location_missing ? "(missing)" : "—")}</td>
                  <td>{e.condition_text || "—"}</td>
                  <td>{e.reported_by_name || e.reported_by_username || "—"}</td>
                  <td>{e.confidence != null ? `${e.confidence}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Unidentified tab ───
function UnidentifiedTab({ flash }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.getTrailerUnidentified(false); setEvents(d.events || []); }
    catch (err) { flash("error", err.message); }
    finally { setLoading(false); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);

  const resolve = async (id) => {
    try { await api.resolveTrailerUnidentified(id); flash("success", "Marked resolved."); load(); }
    catch (err) { flash("error", err.message); }
  };

  return (
    <div>
      <button className="btn" onClick={load} style={{ marginBottom: 12 }}>Refresh</button>
      {loading ? <p>Loading…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead><tr><th>When</th><th>Group</th><th>Reporter</th><th>Unit</th><th>Reason</th><th>Message</th><th></th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={7} style={{ color: "#94a3b8" }}>Nothing to review 🎉</td></tr>}
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{fmtTime(e.created_at)}</td>
                  <td>{e.telegram_group_name || "—"}</td>
                  <td>{e.reported_by_name || e.reported_by_username || "—"}</td>
                  <td>{e.trailer_unit_number || "—"}</td>
                  <td>{e.unidentified_reason || e.event_type}</td>
                  <td style={{ maxWidth: 320, whiteSpace: "pre-wrap" }}>{e.raw_message_text || "—"}</td>
                  <td><button className="btn" onClick={() => resolve(e.id)}>Resolve</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Map tab ───
function MapTab({ flash }) {
  const [data, setData] = useState([]);
  const [showTrailers, setShowTrailers] = useState(true);
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  const load = useCallback(async () => {
    try { const d = await api.getTrailerMapData(); setData(d.trailers || []); }
    catch (err) { flash("error", err.message); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) return;
    const map = L.map(mapContainerRef.current, { zoomControl: true }).setView([39.5, -98.35], 4);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap", maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 200);
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!showTrailers) return;
    const pts = data.filter((t) => t.current_lat != null && t.current_lng != null);
    for (const t of pts) {
      const color = STATUS_COLOR[t.current_status] || STATUS_COLOR.unknown;
      const icon = L.divIcon({
        className: "trailer-marker",
        html: `<div style="width:16px;height:16px;border-radius:3px;background:${color};border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.6)"></div>`,
        iconSize: [16, 16], iconAnchor: [8, 8],
      });
      L.marker([t.current_lat, t.current_lng], { icon })
        .bindPopup(
          `<b>${t.unit_number}</b><br/>Status: ${STATUS_LABEL[t.current_status] || t.current_status}<br/>`
          + `Driver: ${t.current_driver_name || "—"}<br/>Location: ${t.current_location_text || "—"}<br/>`
          + `Condition: ${t.current_condition || "—"}<br/>Reporter: ${t.last_reporter_name || "—"}<br/>`
          + `Last event: ${fmtTime(t.last_event_at)}`
        )
        .addTo(layer);
    }
  }, [data, showTrailers]);

  const textOnly = data.filter((t) => (t.current_lat == null || t.current_lng == null) && t.current_location_text);

  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={showTrailers} onChange={(e) => setShowTrailers(e.target.checked)} />
          Show trailers
        </label>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      <div ref={mapContainerRef} style={{ height: 420, borderRadius: 8, overflow: "hidden", border: "1px solid #33415522" }} />
      {textOnly.length > 0 && (
        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <h4>Text-only locations (not mappable)</h4>
          <ul>
            {textOnly.map((t) => (
              <li key={t.trailer_id}><strong>{t.unit_number}</strong> — {t.current_location_text} ({STATUS_LABEL[t.current_status] || t.current_status})</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Settings tab ───
function SettingsTab({ flash }) {
  const [settings, setSettings] = useState(null);
  const [effectiveTestGroup, setEffectiveTestGroup] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.getTrailerSettings();
      setSettings(d.settings);
      setEffectiveTestGroup(d.effective_test_group_id);
    } catch (err) { flash("error", err.message); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try { const d = await api.updateTrailerSettings(settings); setSettings(d.settings); flash("success", "Settings saved."); }
    catch (err) { flash("error", err.message); }
    finally { setBusy(false); }
  };

  if (!settings) return <p>Loading…</p>;
  const toggle = (k) => setSettings((s) => ({ ...s, [k]: !s[k] }));
  const TOGGLES = [
    ["enabled", "Feature enabled"],
    ["beta_mode", "Beta mode (labels replies)"],
    ["send_driver_group_confirmation", "Reply confirmation in driver group"],
    ["send_reaction", "React 👍 to detected messages"],
    ["ai_fallback_enabled", "AI fallback for unclear messages"],
    ["geocoding_enabled", "Geocode locations to map coordinates"],
  ];

  return (
    <div className="card" style={{ padding: 16, maxWidth: 560 }}>
      <h3>Trailer Tracking settings (Beta)</h3>
      {TOGGLES.map(([k, label]) => (
        <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
          <input type="checkbox" checked={!!settings[k]} onChange={() => toggle(k)} />
          {label}
        </label>
      ))}
      <div style={{ marginTop: 8 }}>
        <label style={{ display: "block", marginBottom: 4 }}>Automatic Updating (Test) group ID</label>
        <input className="form-input" placeholder={effectiveTestGroup || "using env default"}
          value={settings.automatic_update_test_group_id || ""}
          onChange={(e) => setSettings((s) => ({ ...s, automatic_update_test_group_id: e.target.value }))} />
        <small style={{ color: "#94a3b8" }}>Blank = use configured default ({effectiveTestGroup || "none"}).</small>
      </div>
      <div style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={save} disabled={busy}>Save settings</button>
      </div>
    </div>
  );
}

// ─── Trailer detail drawer ───
function TrailerDrawer({ id, onClose, flash }) {
  const [trailer, setTrailer] = useState(null);
  const [status, setStatus] = useState(null);
  const [timeline, setTimeline] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const d = await api.getTrailer(id);
        setTrailer(d.trailer); setStatus(d.status);
        const t = await api.getTrailerTimeline(id);
        setTimeline(t.events || []);
      } catch (err) { flash("error", err.message); }
    })();
  }, [id, flash]);

  if (!trailer) return null;
  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(560px, 100%)", background: "var(--bg, #0f172a)", boxShadow: "-4px 0 20px rgba(0,0,0,.4)", zIndex: 1000, overflowY: "auto", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Trailer {trailer.unit_number}</h2>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <div style={{ marginBottom: 8 }}>
        <StatusBadge status={status?.current_status} needsReview={trailer.needs_review} />
      </div>
      <table className="data-table" style={{ marginBottom: 16 }}>
        <tbody>
          <tr><td>Make</td><td>{trailer.make || "—"}</td></tr>
          <tr><td>Model</td><td>{trailer.model || "—"}</td></tr>
          <tr><td>Plate</td><td>{trailer.plate_number || "—"}</td></tr>
          <tr><td>VIN</td><td>{trailer.vin || "—"}</td></tr>
          <tr><td>Type</td><td>{trailer.type || "—"}</td></tr>
          <tr><td>Year</td><td>{trailer.year || "—"}</td></tr>
          <tr><td>Ownership</td><td>{trailer.ownership_status || "—"}</td></tr>
          <tr><td>Current driver</td><td>{status?.current_driver_name || "—"}</td></tr>
          <tr><td>Current location</td><td>{status?.current_location_text || "—"}</td></tr>
          <tr><td>Last reporter</td><td>{status?.last_reporter_name || "—"}</td></tr>
        </tbody>
      </table>
      <h3>Event timeline</h3>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead><tr><th>When</th><th>Type</th><th>Location</th><th>Condition</th><th>Reporter</th></tr></thead>
          <tbody>
            {timeline.length === 0 && <tr><td colSpan={5} style={{ color: "#94a3b8" }}>No events.</td></tr>}
            {timeline.map((e) => (
              <tr key={e.id}>
                <td>{fmtTime(e.event_time || e.created_at)}</td>
                <td>{e.event_type}</td>
                <td>{e.location_text || "—"}</td>
                <td>{e.condition_text || "—"}</td>
                <td>{e.reported_by_name || e.reported_by_username || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function TrailerTrackingPage() {
  const [tab, setTab] = useState("list");
  const [openId, setOpenId] = useState(null);
  const [toast, setToast] = useState(null);

  const flash = useCallback((type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1>🚚 Trailer Tracking <span style={{ fontSize: 13, color: "#f59e0b" }}>(Beta)</span></h1>
      </div>
      {toast && (
        <div className={`toast ${toast.type}`} style={{
          padding: "8px 14px", borderRadius: 8, marginBottom: 12,
          background: toast.type === "error" ? "#ef444422" : "#22c55e22",
          color: toast.type === "error" ? "#ef4444" : "#22c55e",
        }}>{toast.message}</div>
      )}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #33415533", marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t.key} className={`nav-item ${tab === t.key ? "active" : ""}`}
            style={{ borderBottom: tab === t.key ? "2px solid #6366f1" : "2px solid transparent", borderRadius: 0 }}
            onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "list" && <TrailerListTab onOpen={setOpenId} flash={flash} />}
      {tab === "import" && <ImportTab flash={flash} />}
      {tab === "events" && <EventsTab flash={flash} />}
      {tab === "unidentified" && <UnidentifiedTab flash={flash} />}
      {tab === "map" && <MapTab flash={flash} />}
      {tab === "settings" && <SettingsTab flash={flash} />}

      {openId && <TrailerDrawer id={openId} onClose={() => setOpenId(null)} flash={flash} />}
    </div>
  );
}
