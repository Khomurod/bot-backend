/** Screenshot upload and the staged import batches it produces. */

import React, { useEffect, useState, useCallback } from "react";
import * as api from "../../api";
import { fmtTime } from "./trackingChrome";

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


export default ImportTab;
