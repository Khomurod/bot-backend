import React, { useState } from "react";
import * as api from "../api";

/** YYYY-MM-DD for a date input, from an ISO/date string or null. */
function toDateInput(value) {
  if (!value) return "";
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/**
 * Inline editor for an existing home-time request's DATES — the planned
 * arrival-home date (home_from) and the return-to-road date. Authorized admins
 * open it from the driver activity timeline; saving PUTs to /home-time/requests/:id,
 * which keeps home_to (last day home) consistent and feeds the same corrected
 * dates into request history, driver details, and the efficiency/commitment
 * reports (they read these columns through the linked request).
 *
 * Self-contained: its own draft + open/saving state so HomeTimePage stays lean.
 */
export default function HomeTimeRequestDatesEditor({ requestId, homeFrom, returnToRoad, flash, onSaved }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [from, setFrom] = useState(toDateInput(homeFrom));
  const [ret, setRet] = useState(toDateInput(returnToRoad));

  if (!requestId) return null;

  const startEditing = () => {
    setFrom(toDateInput(homeFrom));
    setRet(toDateInput(returnToRoad));
    setOpen(true);
  };

  const save = async () => {
    if (from && ret && ret <= from) {
      if (flash) flash("error", "Return-to-road date must be after the arrive-home date.");
      return;
    }
    setSaving(true);
    try {
      // Send only the fields the admin actually set; '' clears a date.
      const patch = {
        home_from: from || null,
        return_to_road_date: ret || null,
      };
      await api.updateHomeTimeRequest(requestId, patch);
      if (flash) flash("success", "Home-time request dates updated.");
      setOpen(false);
      if (onSaved) await onSaved();
    } catch (err) {
      if (flash) flash("error", err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-sm" onClick={startEditing} style={{ marginTop: 6 }}>
        Edit dates
      </button>
    );
  }

  return (
    <div className="home-time-form-grid" style={{ marginTop: 8 }}>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label>Arrive home</label>
        <input className="form-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label>Back on the road</label>
        <input className="form-input" type="date" value={ret} onChange={(e) => setRet(e.target.value)} />
      </div>
      <div className="form-group" style={{ marginBottom: 0, alignSelf: "end" }}>
        <div className="home-time-action-row">
          <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save dates"}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
