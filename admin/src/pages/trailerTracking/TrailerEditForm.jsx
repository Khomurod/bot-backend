/** Editing the master-data fields of one trailer. */

import React, { useState } from "react";
import * as api from "../../api";

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


export default TrailerEditForm;
