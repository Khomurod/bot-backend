import React, { useEffect, useState, useCallback } from "react";
import * as api from "../api";
import { displayTrailerStatus, possessionStatusLabel, cargoStatusLabel } from "../utils/trailerState";

// NOTE: the standalone trailer map tab was removed in the follow-up. Trailers now
// render inside the shared "📍 Live Locations" section. This page is for the
// list, import, events, unidentified review, edit, and settings only — no map.
const TABS = [
  { key: "list", label: "Trailer List" },
  { key: "import", label: "Upload / Import" },
  { key: "events", label: "Events History" },
  { key: "planned", label: "Planned" },
  { key: "unidentified", label: "Unidentified" },
  { key: "settings", label: "Settings" },
];

const INSTRUCTION_STATUS_LABEL = {
  pending: "Waiting for completion",
  confirmed: "Completed",
  superseded: "Superseded",
  cancelled: "Cancelled",
};
const INSTRUCTION_STATUS_COLOR = {
  pending: "#f59e0b",
  confirmed: "#22c55e",
  superseded: "#94a3b8",
  cancelled: "#94a3b8",
};

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
const EVENT_TYPES = ["pickup", "dropoff", "mention_only", "unidentified"];

function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

function StatusBadge({ status, needsReview, label }) {
  const s = status || "unknown";
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 12,
      background: STATUS_COLOR[s] + "22", color: STATUS_COLOR[s], fontWeight: 600,
    }}>
      {label || STATUS_LABEL[s] || s}{needsReview ? " • review" : ""}
    </span>
  );
}

function ReviewPill() {
  return (
    <span style={{
      display: "inline-block", marginLeft: 6, padding: "1px 7px", borderRadius: 10, fontSize: 11,
      background: "#ef444422", color: "#ef4444", fontWeight: 700, border: "1px solid #ef444455",
    }}>
      Review change
    </span>
  );
}

// ─── Trailer List tab ───
function TrailerListTab({ onOpen, flash, reloadKey }) {
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

  useEffect(() => { load(); }, [load, reloadKey]);

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
                <th>Unit</th><th>Display Status</th><th>Possession</th><th>Cargo</th><th>Current Driver</th><th>Location</th>
                <th>Last Condition</th><th>Last Event</th><th>Plate</th><th>VIN</th>
                <th>Type</th><th>Ownership</th><th>Last Reporter</th><th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {trailers.length === 0 && (
                <tr><td colSpan={14} style={{ textAlign: "center", color: "#94a3b8" }}>No trailers yet.</td></tr>
              )}
              {trailers.map((t) => {
                const needsReview = !!(t.status_needs_review || t.needs_review);
                return (
                  <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => onOpen(t.id)}>
                    <td><strong>{t.unit_number}</strong></td>
                    <td>
                      <StatusBadge status={t.possession_status || t.current_status} needsReview={needsReview} label={displayTrailerStatus(t)} />
                      {t.status_needs_review ? <ReviewPill /> : null}
                    </td>
                    <td>{possessionStatusLabel(t.possession_status || t.current_status)}</td>
                    <td>{cargoStatusLabel(t.cargo_status)}</td>
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
                );
              })}
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
        <p style={{ color: "#94a3b8" }}>PNG / JPG / WebP, up to 10 MB each, max 4 images and 35 MB per batch. AI reads each row; review before importing. Blank fields never overwrite existing trailer data.</p>
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
function EventsTab({ flash, onOpen }) {
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
            <thead><tr><th>When</th><th>Type</th><th>Review</th><th>Unit</th><th>Group</th><th>Driver</th><th>Location</th><th>Condition</th><th>Reporter</th><th>Conf</th><th></th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={11} style={{ color: "#94a3b8" }}>No events.</td></tr>}
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{fmtTime(e.event_time || e.created_at)}</td>
                  <td>{e.event_type}</td>
                  <td>{e.review_status || "—"}</td>
                  <td><strong>{e.trailer_unit_number || "—"}</strong></td>
                  <td>{e.telegram_group_name || "—"}</td>
                  <td>{e.driver_name || "—"}</td>
                  <td>{e.location_text || (e.location_missing ? "(missing)" : "—")}</td>
                  <td>{e.condition_text || "—"}</td>
                  <td>{e.reported_by_name || e.reported_by_username || "—"}</td>
                  <td>{e.confidence != null ? `${e.confidence}%` : "—"}</td>
                  <td>{e.trailer_id ? <button className="btn" onClick={() => onOpen(e.trailer_id)}>Open</button> : null}</td>
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

// ─── Planned instructions tab ───
// Assigned pickup/drop-off addresses that are NOT yet completed. These never
// change a trailer's confirmed status; they wait for a later message that
// confirms the physical action actually happened.
function PlannedTab({ flash }) {
  const [instructions, setInstructions] = useState(null);
  const [status, setStatus] = useState("pending");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getTrailerPendingInstructions(status);
      setInstructions(d.instructions || []);
    } catch (err) { flash("error", err.message); setInstructions([]); }
  }, [flash, status]);
  useEffect(() => { load(); }, [load]);

  const cancel = async (id) => {
    setBusyId(id);
    try { await api.cancelTrailerPendingInstruction(id); flash("success", "Instruction cancelled."); await load(); }
    catch (err) { flash("error", err.message); }
    finally { setBusyId(null); }
  };

  if (!instructions) return <p>Loading…</p>;

  return (
    <div>
      <p style={{ color: "#94a3b8", fontSize: 13, marginTop: 0 }}>
        Planned pickup/drop-off assignments detected from driver-group messages (e.g. a trailer specialist
        sending a drop-off address). These do <strong>not</strong> change a trailer’s confirmed status — they wait
        for a later message confirming the physical pickup/drop-off actually happened.
      </p>
      <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
        {["pending", "confirmed", "all"].map((s) => (
          <button key={s} className={`btn btn-sm ${status === s ? "btn-primary" : "btn-ghost"}`} onClick={() => setStatus(s)}>
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      {instructions.length === 0 ? (
        <div className="card" style={{ padding: 16, color: "#94a3b8", fontSize: 13 }}>No {status === "all" ? "" : status} instructions.</div>
      ) : (
        instructions.map((it) => (
          <div key={it.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <strong style={{ fontFamily: "monospace" }}>{it.trailer_unit_number}</strong>
                <span style={{ marginLeft: 8, textTransform: "capitalize" }}>{it.planned_action}</span>
                <span style={{
                  marginLeft: 8, padding: "2px 8px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                  background: (INSTRUCTION_STATUS_COLOR[it.instruction_status] || "#94a3b8") + "22",
                  color: INSTRUCTION_STATUS_COLOR[it.instruction_status] || "#94a3b8",
                }}>{INSTRUCTION_STATUS_LABEL[it.instruction_status] || it.instruction_status}</span>
                <div style={{ fontSize: 13, color: "#cbd5e1", marginTop: 4 }}>
                  📍 {it.planned_location || "—"}
                </div>
                <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                  Assigned by {it.reported_by_name || it.reported_by_username || "unknown"}
                  {" · "}{fmtTime(it.instruction_created_at)}
                  {it.confirmed_event_id ? " · completion confirmed" : ""}
                </div>
              </div>
              {it.instruction_status === "pending" && (
                <button className="btn btn-ghost btn-sm" disabled={busyId === it.id} onClick={() => cancel(it.id)}>Cancel</button>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Settings tab ───
function SettingsTab({ flash }) {
  const [settings, setSettings] = useState(null);
  const [effectiveTestGroup, setEffectiveTestGroup] = useState(null);
  const [busy, setBusy] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

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

  const backfill = async () => {
    setBackfilling(true);
    try {
      const d = await api.runTrailerGeocodeBackfill();
      const s = d.summary || {};
      flash("success", `Geocoded ${s.geocoded || 0}, approximate ${s.approximate || 0}, failed ${s.failed || 0}. ${s.remaining || 0} still pending.`);
    } catch (err) { flash("error", err.message); }
    finally { setBackfilling(false); }
  };

  if (!settings) return <p>Loading…</p>;
  const toggle = (k) => setSettings((s) => ({ ...s, [k]: !s[k] }));
  const silent = settings.silent_driver_group_monitoring !== false;
  const TOGGLES = [
    ["enabled", "Feature enabled"],
    ["beta_mode", "Beta mode (labels replies)"],
    ["silent_driver_group_monitoring", "Silent driver-group monitoring (recommended)"],
    ["send_driver_group_confirmation", "Reply confirmation in driver group"],
    ["send_reaction", "React 👍 to detected messages"],
    ["ai_fallback_enabled", "AI fallback for unclear messages"],
    ["geocoding_enabled", "Geocode locations to map coordinates"],
    ["semantic_ai_required", "Require AI semantic verification before any status change (fail closed)"],
  ];
  const setNum = (k) => (e) => setSettings((s) => ({ ...s, [k]: e.target.value === "" ? "" : Number(e.target.value) }));

  return (
    <div className="card" style={{ padding: 16, maxWidth: 560 }}>
      <h3>Trailer Tracking settings (Beta)</h3>
      {TOGGLES.map(([k, label]) => {
        // In silent mode the driver-group reply/reaction toggles have no effect —
        // show them disabled so the behavior is not misleading.
        const overridden = silent && (k === "send_driver_group_confirmation" || k === "send_reaction");
        return (
          <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", opacity: overridden ? 0.5 : 1 }}>
            <input type="checkbox" checked={!!settings[k]} disabled={overridden} onChange={() => toggle(k)} />
            {label}{overridden ? " (overridden by silent mode)" : ""}
          </label>
        );
      })}
      <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
        Trailer messages are analyzed and registered without replying or reacting in driver groups.
        {silent
          ? " Silent mode is on: nothing is sent back to the driver group. The internal Automatic Updating (Test) group still receives review alerts."
          : " Silent mode is off: the reply/reaction toggles above control driver-group output."}
      </p>
      <div style={{ marginTop: 8 }}>
        <label style={{ display: "block", marginBottom: 4 }}>Automatic Updating (Test) group ID</label>
        <input className="form-input" placeholder={effectiveTestGroup || "using env default"}
          value={settings.automatic_update_test_group_id || ""}
          onChange={(e) => setSettings((s) => ({ ...s, automatic_update_test_group_id: e.target.value }))} />
        <small style={{ color: "#94a3b8" }}>Blank = use configured default ({effectiveTestGroup || "none"}).</small>
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label style={{ display: "block" }}>
          <span style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>Auto-register confidence (default 92)</span>
          <input className="form-input" type="number" min="50" max="100" style={{ width: 120 }}
            value={settings.auto_register_confidence ?? 92} onChange={setNum("auto_register_confidence")} />
        </label>
        <label style={{ display: "block" }}>
          <span style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>Review confidence (default 75)</span>
          <input className="form-input" type="number" min="0" max="100" style={{ width: 120 }}
            value={settings.review_confidence ?? 75} onChange={setNum("review_confidence")} />
        </label>
      </div>
      <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
        AI-verified events at or above the auto-register confidence can change trailer status; between review and
        auto-register they go to Needs Review only; below review confidence they are ignored. If AI verification is
        unavailable, candidates always fail closed to review — no status change.
      </p>
      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-primary" onClick={save} disabled={busy}>Save settings</button>
        <button className="btn" onClick={backfill} disabled={backfilling} title="Geocode a bounded batch of events missing coordinates">
          {backfilling ? "Geocoding…" : "Geocode missing locations"}
        </button>
      </div>
      <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 8 }}>
        Backfill geocodes a small, bounded batch per click (never on boot) and updates the map for the shared 📍 Live Locations view.
      </p>
    </div>
  );
}

// ─── Event edit form (used inside the drawer) ───
function EventEditForm({ event, flash, onSaved, onCancel }) {
  const [form, setForm] = useState({
    event_type: event.event_type || "pickup",
    cargo_status: event.cargo_status || "unknown",
    trailer_unit_number: event.trailer_unit_number || "",
    location_text: event.location_text || "",
    location_lat: event.location_lat ?? "",
    location_lng: event.location_lng ?? "",
    condition_text: event.condition_text || "",
    driver_name: event.driver_name || "",
    reported_driver_name_from_message: event.reported_driver_name_from_message || "",
    event_time: event.event_time ? new Date(event.event_time).toISOString().slice(0, 16) : "",
    note: "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      const patch = {
        event_type: form.event_type,
        cargo_status: form.cargo_status,
        trailer_unit_number: form.trailer_unit_number || undefined,
        location_text: form.location_text,
        condition_text: form.condition_text,
        driver_name: form.driver_name,
        reported_driver_name_from_message: form.reported_driver_name_from_message,
        note: form.note || undefined,
      };
      if (form.location_lat !== "" && form.location_lng !== "") {
        patch.location_lat = Number(form.location_lat);
        patch.location_lng = Number(form.location_lng);
      }
      if (form.event_time) patch.event_time = new Date(form.event_time).toISOString();
      await api.correctTrailerEvent(event.id, patch);
      flash("success", "Change saved and status recomputed.");
      onSaved();
    } catch (err) { flash("error", err.message); }
    finally { setBusy(false); }
  };

  const field = (label, k, props = {}) => (
    <label style={{ display: "block", marginBottom: 8 }}>
      <span style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>{label}</span>
      <input className="form-input" value={form[k]} onChange={(e) => set(k, e.target.value)} {...props} />
    </label>
  );

  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, border: "1px solid #6366f155" }}>
      <h4 style={{ marginTop: 0 }}>Edit change</h4>
      <label style={{ display: "block", marginBottom: 8 }}>
        <span style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>Event type</span>
        <select className="form-input" value={form.event_type} onChange={(e) => set("event_type", e.target.value)}>
          {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <label style={{ display: "block", marginBottom: 8 }}>
        <span style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>
          Cargo status (possession follows the event type: pickup → with driver, drop-off → dropped)
        </span>
        <select className="form-input" value={form.cargo_status} onChange={(e) => set("cargo_status", e.target.value)}>
          {["empty", "loaded", "unknown"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      {field("Trailer unit", "trailer_unit_number")}
      {field("Location text", "location_text")}
      <div style={{ display: "flex", gap: 8 }}>
        {field("Lat", "location_lat", { type: "number", step: "any" })}
        {field("Lng", "location_lng", { type: "number", step: "any" })}
      </div>
      {field("Condition", "condition_text")}
      {field("Driver name", "driver_name")}
      {field("Reported driver name", "reported_driver_name_from_message")}
      {field("Event date/time", "event_time", { type: "datetime-local" })}
      {field("Note", "note")}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn btn-primary" onClick={save} disabled={busy}>Save change</button>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Trailer detail edit form ───
function TrailerEditForm({ trailer, flash, onSaved, onCancel }) {
  const [form, setForm] = useState({
    make: trailer.make || "", model: trailer.model || "", mc_number: trailer.mc_number || "",
    plate_number: trailer.plate_number || "", type: trailer.type || "", vin: trailer.vin || "",
    year: trailer.year || "", ownership_status: trailer.ownership_status || "",
    active: trailer.active !== false, needs_review: !!trailer.needs_review,
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    // Light validation (soft): warn but do not hard-block.
    if (form.vin && !/^[A-Za-z0-9]{6,17}$/.test(form.vin.trim())) {
      flash("error", "VIN looks invalid (expect 6–17 letters/digits)."); return;
    }
    if (form.year && !/^\d{4}$/.test(String(form.year).trim())) {
      flash("error", "Year should be 4 digits."); return;
    }
    setBusy(true);
    try {
      // Only send fields that have a value (blank text never clobbers existing
      // data server-side); booleans are always sent so they can be toggled.
      const patch = { active: form.active, needs_review: form.needs_review };
      for (const k of ["make", "model", "mc_number", "plate_number", "type", "vin", "year", "ownership_status"]) {
        if (String(form[k]).trim() !== "") patch[k] = form[k];
      }
      await api.updateTrailer(trailer.id, patch);
      flash("success", "Trailer details saved.");
      onSaved();
    } catch (err) { flash("error", err.message); }
    finally { setBusy(false); }
  };

  const field = (label, k, props = {}) => (
    <label style={{ display: "block", marginBottom: 8 }}>
      <span style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>{label}</span>
      <input className="form-input" value={form[k]} onChange={(e) => set(k, e.target.value)} {...props} />
    </label>
  );

  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, border: "1px solid #6366f155" }}>
      <h4 style={{ marginTop: 0 }}>Edit trailer details</h4>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>
        Unit <strong>{trailer.unit_number}</strong> (the unit number is the stable key and is not editable here). Blank fields are left unchanged.
      </div>
      {field("Make", "make")}
      {field("Model", "model")}
      {field("MC number", "mc_number")}
      {field("Plate number", "plate_number")}
      {field("Type", "type")}
      {field("VIN", "vin")}
      {field("Year", "year")}
      {field("Ownership status", "ownership_status")}
      <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
        <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} /> Active
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
        <input type="checkbox" checked={form.needs_review} onChange={(e) => set("needs_review", e.target.checked)} /> Needs review (data quality)
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn btn-primary" onClick={save} disabled={busy}>Save details</button>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Trailer detail drawer ───
function TrailerDrawer({ id, onClose, flash, onChanged }) {
  const [data, setData] = useState(null); // { trailer, status, review }
  const [timeline, setTimeline] = useState([]);
  const [editingTrailer, setEditingTrailer] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null); // event object being edited
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.getTrailer(id);
      setData({ trailer: d.trailer, status: d.status, review: d.review || {} });
      const t = await api.getTrailerTimeline(id);
      setTimeline(t.events || []);
    } catch (err) { flash("error", err.message); }
  }, [id, flash]);

  useEffect(() => { load(); }, [load]);

  const afterChange = useCallback(async () => {
    setEditingTrailer(false);
    setEditingEvent(null);
    await load();
    if (onChanged) onChanged();
  }, [load, onChanged]);

  const accept = async (eventId) => {
    setBusy(true);
    try { await api.acceptTrailerEvent(eventId); flash("success", "Change accepted."); await afterChange(); }
    catch (err) { flash("error", err.message); }
    finally { setBusy(false); }
  };
  const decline = async (eventId) => {
    setBusy(true);
    try { await api.declineTrailerEvent(eventId); flash("success", "Change declined; previous status restored."); await afterChange(); }
    catch (err) { flash("error", err.message); }
    finally { setBusy(false); }
  };

  if (!data) return null;
  const { trailer, status, review } = data;
  const pending = review && review.pendingEvent;
  const previous = review && review.previousEvent;

  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(600px, 100%)", background: "var(--bg, #0f172a)", boxShadow: "-4px 0 20px rgba(0,0,0,.4)", zIndex: 1000, overflowY: "auto", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Trailer {trailer.unit_number}</h2>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <div style={{ margin: "8px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <StatusBadge status={status?.possession_status || status?.current_status} needsReview={!!(status?.needs_review || trailer.needs_review)} label={status ? displayTrailerStatus(status) : undefined} />
        <span style={{ fontSize: 12, color: "#94a3b8" }}>
          Possession: {possessionStatusLabel(status?.possession_status || status?.current_status)} · Cargo: {cargoStatusLabel(status?.cargo_status)}
        </span>
      </div>

      {/* ── Review panel: latest detected change awaiting a decision ── */}
      {pending && !editingEvent && (
        <div className="card" style={{ padding: 14, marginBottom: 12, border: "1px solid #ef444455", background: "#ef44440d" }}>
          <h4 style={{ marginTop: 0, color: "#ef4444" }}>Detected change needs review</h4>
          <div style={{ fontSize: 14, marginBottom: 6 }}>
            <div><strong>Detected:</strong> {pending.event_type} · {pending.location_text || "(no location)"} · {pending.condition_text || "—"}</div>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              Reported by {pending.reported_by_name || pending.reported_by_username || "—"} · {fmtTime(pending.event_time || pending.created_at)}
            </div>
            <div style={{ marginTop: 6 }}>
              <span style={{ color: "#94a3b8" }}>Current confirmed status: </span>
              <StatusBadge status={status?.possession_status || status?.current_status} label={status ? displayTrailerStatus(status) : undefined} />
            </div>
            {previous && (
              <div style={{ marginTop: 4, fontSize: 12, color: "#94a3b8" }}>
                Previous confirmed: {previous.event_type} · {previous.location_text || "—"} · {fmtTime(previous.event_time || previous.created_at)}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={() => accept(pending.id)} disabled={busy}>Accept</button>
            <button className="btn" style={{ borderColor: "#ef4444", color: "#ef4444" }} onClick={() => decline(pending.id)} disabled={busy}>Decline the change</button>
            <button className="btn" onClick={() => setEditingEvent(pending)} disabled={busy}>Edit the change</button>
          </div>
        </div>
      )}

      {editingEvent && (
        <EventEditForm event={editingEvent} flash={flash} onSaved={afterChange} onCancel={() => setEditingEvent(null)} />
      )}

      {/* ── Trailer details (view / edit) ── */}
      {editingTrailer ? (
        <TrailerEditForm trailer={trailer} flash={flash} onSaved={afterChange} onCancel={() => setEditingTrailer(false)} />
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: "8px 0" }}>Details</h3>
            <button className="btn" onClick={() => setEditingTrailer(true)}>Edit details</button>
          </div>
          <table className="data-table" style={{ marginBottom: 16 }}>
            <tbody>
              <tr><td>Make</td><td>{trailer.make || "—"}</td></tr>
              <tr><td>Model</td><td>{trailer.model || "—"}</td></tr>
              <tr><td>MC #</td><td>{trailer.mc_number || "—"}</td></tr>
              <tr><td>Plate</td><td>{trailer.plate_number || "—"}</td></tr>
              <tr><td>VIN</td><td>{trailer.vin || "—"}</td></tr>
              <tr><td>Type</td><td>{trailer.type || "—"}</td></tr>
              <tr><td>Year</td><td>{trailer.year || "—"}</td></tr>
              <tr><td>Ownership</td><td>{trailer.ownership_status || "—"}</td></tr>
              <tr><td>Active</td><td>{trailer.active === false ? "No" : "Yes"}</td></tr>
              <tr><td>Current driver</td><td>{status?.current_driver_name || "—"}</td></tr>
              <tr><td>Current location</td><td>{status?.current_location_text || "—"}{status?.location_source ? ` (${status.location_source})` : ""}</td></tr>
              <tr><td>Last reporter</td><td>{status?.last_reporter_name || "—"}</td></tr>
            </tbody>
          </table>
        </>
      )}

      <h3>Event timeline</h3>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead><tr><th>When</th><th>Type</th><th>Review</th><th>Location</th><th>Condition</th><th>Reporter</th><th></th></tr></thead>
          <tbody>
            {timeline.length === 0 && <tr><td colSpan={7} style={{ color: "#94a3b8" }}>No events.</td></tr>}
            {timeline.map((e) => (
              <tr key={e.id} style={e.review_status === "declined" ? { opacity: 0.55 } : undefined}>
                <td>{fmtTime(e.event_time || e.created_at)}</td>
                <td>{e.event_type}</td>
                <td>{e.review_status || "—"}</td>
                <td>{e.location_text || "—"}</td>
                <td>{e.condition_text || "—"}</td>
                <td>{e.reported_by_name || e.reported_by_username || "—"}</td>
                <td>
                  {(e.event_type === "pickup" || e.event_type === "dropoff") && (
                    <button className="btn" onClick={() => setEditingEvent(e)}>Edit</button>
                  )}
                </td>
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
  const [reloadKey, setReloadKey] = useState(0);

  const flash = useCallback((type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const bumpReload = useCallback(() => setReloadKey((k) => k + 1), []);

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

      {tab === "list" && <TrailerListTab onOpen={setOpenId} flash={flash} reloadKey={reloadKey} />}
      {tab === "import" && <ImportTab flash={flash} />}
      {tab === "events" && <EventsTab flash={flash} onOpen={setOpenId} />}
      {tab === "planned" && <PlannedTab flash={flash} />}
      {tab === "unidentified" && <UnidentifiedTab flash={flash} />}
      {tab === "settings" && <SettingsTab flash={flash} />}

      {openId && <TrailerDrawer id={openId} onClose={() => setOpenId(null)} flash={flash} onChanged={bumpReload} />}
    </div>
  );
}
