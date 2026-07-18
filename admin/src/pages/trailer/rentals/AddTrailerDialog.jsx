import React, { useMemo, useState } from "react";
import { Alert, Field, Modal } from "../TrailerUi";
import {
  PRICING_MODES, rateFieldFor, selectableTrailersForAdd, filterTrailersByText,
  addTrailerBlockers, buildAddItemPayload,
} from "./addTrailer";

/**
 * "Add a trailer to this rental" — the true ADD workflow (distinct from
 * Swap/Replace). It picks an available trailer not already on the rental, sets
 * the pickup window, location and pricing, and creates a scheduled item through
 * an add_trailer amendment. Form state is preserved after a server error so a
 * plain-language conflict (overlap, unavailable) can be corrected in place.
 */
export default function AddTrailerDialog({ trailers, existingItems, onClose, onSubmit }) {
  const [form, setForm] = useState({
    trailer_id: "", scheduled_pickup_at: "", expected_return_at: "", pickup_location: "",
    pricing_mode: "daily", daily_rate: "", weekly_rate: "", monthly_rate: "", flat_amount: "",
    notes: "", reason: "",
  });
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  // Exclude trailers already on the rental, and non-official / unavailable stock.
  const selectable = useMemo(
    () => selectableTrailersForAdd(trailers, existingItems),
    [trailers, existingItems],
  );
  const matches = useMemo(() => filterTrailersByText(selectable, search), [selectable, search]);

  const missing = addTrailerBlockers(form);
  const canSubmit = missing.length === 0;
  const rateField = rateFieldFor(form.pricing_mode);

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(buildAddItemPayload(form), form.reason || "Added after rental creation");
      // Parent closes on success; on error we keep the form for correction.
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a trailer to this rental" onClose={busy ? undefined : onClose} wide>
      {error && <Alert message={{ type: "error", text: error }} />}
      <form onSubmit={submit} className="trailer-form-grid">
        <Field label="Search trailers by number, VIN or plate">
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. 1045" aria-label="Search available trailers" />
        </Field>
        <Field label="Trailer">
          <select required value={form.trailer_id} onChange={(e) => set({ trailer_id: e.target.value })}>
            <option value="">Select an available trailer…</option>
            {matches.map((t) => (
              <option key={t.id} value={t.id}>
                {t.unit_number}{t.condition ? ` — ${t.condition}` : ""}
              </option>
            ))}
          </select>
        </Field>
        {!selectable.length && (
          <p className="trailer-help">No available trailers to add. Every active trailer is rented, reserved or already on this rental.</p>
        )}

        <Field label="Scheduled pickup">
          <input required type="datetime-local" value={form.scheduled_pickup_at}
            onChange={(e) => set({ scheduled_pickup_at: e.target.value })} />
        </Field>
        <Field label="Expected return">
          <input required type="datetime-local" value={form.expected_return_at}
            onChange={(e) => set({ expected_return_at: e.target.value })} />
        </Field>
        <Field label="Pickup location">
          <input value={form.pickup_location} onChange={(e) => set({ pickup_location: e.target.value })} />
        </Field>

        <Field label="Pricing">
          <select value={form.pricing_mode} onChange={(e) => set({ pricing_mode: e.target.value })}>
            {PRICING_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label={PRICING_MODES.find(([v]) => v === form.pricing_mode)?.[1] || "Rate"}>
          <input type="number" min="0" step="0.01" value={form[rateField]}
            onChange={(e) => set({ [rateField]: e.target.value })} />
        </Field>

        <Field label="Notes (optional)">
          <input value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <Field label="Reason for adding after rental creation">
          <input value={form.reason} onChange={(e) => set({ reason: e.target.value })}
            placeholder="e.g. customer added a load" />
        </Field>

        {!canSubmit && (
          <div className="alert alert-warning" role="alert">
            <p style={{ margin: 0, fontWeight: 600 }}>Before you can add this trailer:</p>
            <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
              {missing.map((m) => <li key={m}>{m}</li>)}
            </ul>
          </div>
        )}
        <button className="btn btn-primary" type="submit" disabled={!canSubmit || busy}>
          {busy ? "Adding…" : "Add trailer"}
        </button>
      </form>
    </Modal>
  );
}
