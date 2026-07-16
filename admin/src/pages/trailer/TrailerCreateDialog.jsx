import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { Card, Field, PageHeader } from "./TrailerUi";

const PHYSICAL_STATUSES = [
  "unknown",
  "available",
  "rented",
  "under_inspection",
  "maintenance",
  "out_of_service",
  "held_damage",
];

const EMPTY = {
  unit_number: "",
  physical_status: "unknown",
  tracking_reference: "",
  notes: "",
  verified: false,
};

/**
 * Adds a trailer from the Trailers page. Marking a trailer available is a claim
 * about the physical yard, so it requires the verification checkbox; anything
 * left unverified stays review-required (needs_review is the checkbox inverse).
 */
export default function TrailerCreateDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({ ...EMPTY });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const needsVerification = form.physical_status === "available" && !form.verified;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { trailer } = await api.createTrailer({
        unit_number: form.unit_number.trim(),
        physical_status: form.physical_status,
        tracking_reference: form.tracking_reference.trim() || null,
        notes: form.notes.trim() || null,
        needs_review: !form.verified,
      });
      onCreated(trailer);
    } catch (e) {
      // The dialog and its values stay put so the entry can be corrected.
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trailer-modal-backdrop">
      <Card className="trailer-modal">
        <PageHeader
          title="Add trailer"
          actions={
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          }
        />
        {error && <div className="alert alert-danger">{error}</div>}
        <Field label="Unit number">
          <input
            required
            autoFocus
            value={form.unit_number}
            onChange={(e) => set({ unit_number: e.target.value })}
          />
        </Field>
        <Field label="Physical status">
          <select
            value={form.physical_status}
            onChange={(e) => set({ physical_status: e.target.value })}
          >
            {PHYSICAL_STATUSES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </Field>
        <Field label="Tracking reference">
          <input
            value={form.tracking_reference}
            onChange={(e) => set({ tracking_reference: e.target.value })}
          />
        </Field>
        <Field label="Notes">
          <textarea value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <label className="trailer-check">
          <input
            type="checkbox"
            checked={form.verified}
            onChange={(e) => set({ verified: e.target.checked })}
          />
          Physical availability verified
        </label>
        {needsVerification && (
          <p className="trailer-help">
            Confirm the trailer was physically verified before marking it available.
          </p>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !form.unit_number.trim() || needsVerification}
          onClick={save}
        >
          {busy ? "Saving…" : "Save trailer"}
        </button>
      </Card>
    </div>
  );
}
