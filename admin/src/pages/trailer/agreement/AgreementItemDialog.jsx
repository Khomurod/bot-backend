import React, { useState } from "react";
import { Alert, Field, Modal } from "../TrailerUi";
import { RETURN_STATUSES } from "./agreementConstants";

const TITLES = {
  schedule: "Schedule pickup",
  return: "Return trailer",
  extend: "Extend return",
  replace: "Replace trailer",
  remove: "Remove trailer",
};

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function initialForm(action) {
  if (action === "schedule") {
    return { scheduled_pickup_at: "", expected_return_at: "", pickup_location: "" };
  }
  if (action === "extend") return { expected_return_at: "", reason: "" };
  if (action === "remove") return { reason: "" };
  if (action === "replace") return { trailer_id: "", reason: "" };
  return {
    actual_return_at: "",
    return_location: "",
    return_lat: "",
    return_lng: "",
    trailer_status: "available",
    new_damage: false,
    damage_charge: "0",
    cleaning_charge: "0",
    late_fee: "0",
    other_charge: "0",
    discount: "0",
    description: "",
  };
}

function buildPayload(action, form) {
  if (action === "schedule") {
    return {
      scheduled_pickup_at: toIso(form.scheduled_pickup_at),
      expected_return_at: toIso(form.expected_return_at),
      pickup_location: form.pickup_location || null,
    };
  }
  if (action === "extend") {
    return { expected_return_at: toIso(form.expected_return_at), reason: form.reason || null };
  }
  if (action === "remove") return { reason: form.reason || null };
  if (action === "replace") {
    return { item: { trailer_id: Number(form.trailer_id) }, reason: form.reason || null };
  }
  return {
    actual_return_at: toIso(form.actual_return_at) || new Date().toISOString(),
    return_location: form.return_location || null,
    return_lat: form.return_lat === "" ? null : Number(form.return_lat),
    return_lng: form.return_lng === "" ? null : Number(form.return_lng),
    trailer_status: form.trailer_status,
    new_damage: form.new_damage,
    damage_charge: Number(form.damage_charge || 0),
    cleaning_charge: Number(form.cleaning_charge || 0),
    late_fee: Number(form.late_fee || 0),
    other_charge: Number(form.other_charge || 0),
    discount: Number(form.discount || 0),
    description: form.description || null,
  };
}

function ReturnFields({ form, set }) {
  const charges = [
    ["damage_charge", "Damage charge"],
    ["cleaning_charge", "Cleaning charge"],
    ["late_fee", "Late fee"],
    ["other_charge", "Other charge"],
    ["discount", "Discount"],
  ];
  return (
    <>
      <Field label="Actual return date/time">
        <input
          type="datetime-local"
          value={form.actual_return_at}
          onChange={(e) => set({ actual_return_at: e.target.value })}
        />
      </Field>
      <Field label="Return location">
        <input
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
          value={form.trailer_status}
          onChange={(e) => set({ trailer_status: e.target.value })}
        >
          {RETURN_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      {charges.map(([key, label]) => (
        <Field key={key} label={label}>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form[key]}
            onChange={(e) => set({ [key]: e.target.value })}
          />
        </Field>
      ))}
      <Field label="Damage description / notes">
        <textarea
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </Field>
    </>
  );
}

/**
 * One dialog for every per-item amendment action. It gathers inputs and calls
 * `onSubmit(payload)`; the detail page maps the action to the API call. Form
 * state is retained on error and submit is disabled while in flight.
 */
export default function AgreementItemDialog({ action, item, trailers, onClose, onSubmit }) {
  const [form, setForm] = useState(() => initialForm(action));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const damageFlagged =
    action === "return" && (Number(form.damage_charge || 0) > 0 || form.new_damage);
  const damageBlocksAvailable = damageFlagged && form.trailer_status === "available";
  const valid =
    !damageBlocksAvailable &&
    (action !== "replace" || form.trailer_id) &&
    (action !== "return" || form.return_location.trim());

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(buildPayload(action, form));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={TITLES[action]} onClose={onClose} wide>
      {error && <Alert message={{ type: "error", text: error }} />}
      <form onSubmit={submit} className="trailer-form-grid">
        {action === "schedule" && (
          <>
            <Field label="Scheduled pickup">
              <input
                type="datetime-local"
                value={form.scheduled_pickup_at}
                onChange={(e) => set({ scheduled_pickup_at: e.target.value })}
              />
            </Field>
            <Field label="Expected return">
              <input
                type="datetime-local"
                value={form.expected_return_at}
                onChange={(e) => set({ expected_return_at: e.target.value })}
              />
            </Field>
            <Field label="Pickup location">
              <input
                value={form.pickup_location}
                onChange={(e) => set({ pickup_location: e.target.value })}
              />
            </Field>
          </>
        )}
        {action === "extend" && (
          <>
            <Field label="New expected return">
              <input
                required
                type="datetime-local"
                value={form.expected_return_at}
                onChange={(e) => set({ expected_return_at: e.target.value })}
              />
            </Field>
            <Field label="Reason">
              <input
                value={form.reason}
                onChange={(e) => set({ reason: e.target.value })}
              />
            </Field>
          </>
        )}
        {action === "remove" && (
          <Field label="Reason">
            <textarea
              value={form.reason}
              onChange={(e) => set({ reason: e.target.value })}
            />
          </Field>
        )}
        {action === "replace" && (
          <>
            <Field label="Replacement trailer">
              <select
                required
                value={form.trailer_id}
                onChange={(e) => set({ trailer_id: e.target.value })}
              >
                <option value="">Select…</option>
                {trailers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.unit_number}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason">
              <input
                value={form.reason}
                onChange={(e) => set({ reason: e.target.value })}
              />
            </Field>
          </>
        )}
        {action === "return" && <ReturnFields form={form} set={set} />}
        {action === "return" && (
          <label className="trailer-check">
            <input
              type="checkbox"
              checked={form.new_damage}
              onChange={(e) => set({ new_damage: e.target.checked })}
            />
            New damage recorded on this return
          </label>
        )}
        {damageBlocksAvailable && (
          <p className="trailer-help" style={{ color: "#b91c1c" }}>
            Damage was charged or flagged — choose a status other than "Available".
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={!valid || busy}>
          {busy ? "Working…" : TITLES[action]}
        </button>
      </form>
    </Modal>
  );
}
