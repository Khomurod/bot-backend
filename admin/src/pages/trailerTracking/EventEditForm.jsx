/**
 * Correcting one event. Events are immutable, so a correction is recorded as a
 * correction — it does not rewrite history in place.
 */

import React, { useState } from "react";
import * as api from "../../api";
import { EVENT_TYPES } from "./trackingChrome";

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


export default EventEditForm;
