import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { Card, Field, PageHeader } from "./TrailerUi";
import { TRAILER_CONDITION_LABELS } from "./trailerStatusVocabulary";

/**
 * Edit one trailer's condition, tracking reference and notes. Sends the
 * optimistic-lock version so a concurrent edit surfaces as a clear 409
 * instead of a silent overwrite.
 */
export default function TrailerEditDialog({ trailer, onClose, onSaved }) {
  const [form, setForm] = useState({ ...trailer });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api.updateTrailer(form.id, {
        physical_status: form.physical_status,
        needs_review: form.needs_review,
        tracking_reference: form.tracking_reference,
        notes: form.notes,
        version: form.version,
      });
      onSaved();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="trailer-modal-backdrop" role="dialog" aria-modal="true">
      <Card className="trailer-modal">
        <PageHeader
          title={`Trailer ${form.unit_number}`}
          actions={<button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>Close</button>}
        />
        {error && <div className="alert alert-danger">{error}</div>}
        <Field label="Trailer condition">
          <select
            value={form.physical_status}
            onChange={(e) => setForm({ ...form, physical_status: e.target.value })}
          >
            {Object.entries(TRAILER_CONDITION_LABELS).map(([value, s]) => (
              <option key={value} value={value}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Tracking reference (optional)">
          <input
            value={form.tracking_reference || ""}
            onChange={(e) => setForm({ ...form, tracking_reference: e.target.value })}
          />
        </Field>
        <Field label="Notes (optional)">
          <textarea
            value={form.notes || ""}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </Field>
        <label className="trailer-check">
          <input
            type="checkbox"
            checked={!form.needs_review}
            onChange={(e) => setForm({ ...form, needs_review: !e.target.checked })}
          />
          Availability verified
        </label>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save trailer"}
        </button>
      </Card>
    </div>
  );
}
