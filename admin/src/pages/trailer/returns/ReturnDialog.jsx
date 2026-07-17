import React, { useState } from "react";
import { Alert, Field, Modal } from "../TrailerUi";

/** Status the trailer moves to after a return. */
const RETURN_STATUSES = [
  { value: "available", label: "Available" },
  { value: "held_damage", label: "Held — damage" },
  { value: "maintenance", label: "Maintenance" },
  { value: "out_of_service", label: "Out of service" },
];

const CHARGE_FIELDS = [
  { key: "damage_charge", label: "Damage charge" },
  { key: "cleaning_charge", label: "Cleaning charge" },
  { key: "late_fee", label: "Late fee" },
  { key: "other_charges", label: "Other charge" },
  { key: "discount_amount", label: "Discount" },
];

function nowLocal() {
  // datetime-local wants YYYY-MM-DDTHH:mm in local time.
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

/**
 * Collects every field the rental-return flow needs, replacing the old
 * browser prompt() pair. It does not call the API itself — the page passes
 * `onSubmit(payload)` which performs the existing returnRental call. Form state
 * is retained on error, the backend error is shown via Alert, and the submit
 * button is disabled while in flight.
 */
export default function ReturnDialog({ rental, initialNewDamage = false, onClose, onSubmit }) {
  const [form, setForm] = useState({
    actual_return_at: nowLocal(),
    return_location: "",
    return_lat: "",
    return_lng: "",
    physical_status: "available",
    new_damage: Boolean(initialNewDamage),
    damage_charge: "0",
    cleaning_charge: "0",
    late_fee: "0",
    other_charges: "0",
    discount_amount: "0",
    notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const damageFlagged = Number(form.damage_charge || 0) > 0 || form.new_damage;
  const damageBlocksAvailable = damageFlagged && form.physical_status === "available";
  const canSubmit =
    Boolean(form.return_location.trim()) && !damageBlocksAvailable && !busy;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        actual_return_at: new Date(form.actual_return_at).toISOString(),
        return_location: form.return_location.trim(),
        return_lat: form.return_lat === "" ? null : Number(form.return_lat),
        return_lng: form.return_lng === "" ? null : Number(form.return_lng),
        physical_status: form.physical_status,
        new_damage: form.new_damage,
        damage_charge: Number(form.damage_charge || 0),
        cleaning_charge: Number(form.cleaning_charge || 0),
        late_fee: Number(form.late_fee || 0),
        other_charges: Number(form.other_charges || 0),
        discount_amount: Number(form.discount_amount || 0),
        notes: form.notes.trim() || null,
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Return trailer"
      subtitle={rental ? `${rental.unit_number} — ${rental.company_name}` : undefined}
      onClose={onClose}
      wide
    >
      {error && <Alert message={{ type: "error", text: error }} />}
      <form onSubmit={submit} className="trailer-form-grid">
        <Field label="Actual return date/time">
          <input
            required
            type="datetime-local"
            value={form.actual_return_at}
            onChange={(e) => set({ actual_return_at: e.target.value })}
          />
        </Field>
        <Field label="Return location">
          <input
            required
            value={form.return_location}
            onChange={(e) => set({ return_location: e.target.value })}
          />
        </Field>
        <Field label="Latitude (optional)">
          <input
            type="number"
            step="any"
            value={form.return_lat}
            onChange={(e) => set({ return_lat: e.target.value })}
          />
        </Field>
        <Field label="Longitude (optional)">
          <input
            type="number"
            step="any"
            value={form.return_lng}
            onChange={(e) => set({ return_lng: e.target.value })}
          />
        </Field>
        <Field label="Status after return">
          <select
            value={form.physical_status}
            onChange={(e) => set({ physical_status: e.target.value })}
          >
            {RETURN_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        {CHARGE_FIELDS.map((c) => (
          <Field key={c.key} label={c.label}>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form[c.key]}
              onChange={(e) => set({ [c.key]: e.target.value })}
            />
          </Field>
        ))}
        <Field label="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </Field>
        <label className="trailer-check">
          <input
            type="checkbox"
            checked={form.new_damage}
            onChange={(e) => set({ new_damage: e.target.checked })}
          />
          New damage recorded on this return
        </label>
        {damageBlocksAvailable && (
          <p className="trailer-help" style={{ color: "#b91c1c" }}>
            Damage was charged or flagged — choose a status other than "Available".
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
          {busy ? "Returning…" : "Confirm return and invoice"}
        </button>
      </form>
    </Modal>
  );
}
