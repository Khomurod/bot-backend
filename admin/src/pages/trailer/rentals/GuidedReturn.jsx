import React, { useState } from "react";
import ag from "../../../api/trailerAgreements";
import dept from "../../../api/trailerDepartment";
import { Field, Modal } from "../TrailerUi";

const CONDITION_FIELDS = [
  ["overall_condition", "Overall condition"],
  ["tires", "Tires"],
  ["lights", "Lights"],
  ["doors", "Doors"],
  ["roof", "Roof"],
  ["floor", "Floor"],
  ["exterior", "Exterior"],
  ["interior", "Interior"],
  ["landing_gear", "Landing gear"],
];
const CONDITION_CHOICES = ["Good", "Fair", "Needs attention"];

const AFTER_RETURN = [
  ["available", "Available"],
  ["under_inspection", "Needs inspection"],
  ["maintenance", "Maintenance"],
  ["held_damage", "Held because of damage"],
  ["out_of_service", "Out of service"],
];

const CHARGE_TYPES = [
  ["damage_charge", "Damage"],
  ["cleaning_charge", "Cleaning"],
  ["late_fee", "Late fee"],
  ["other_charge", "Other"],
];

const STEPS = ["Condition", "Photos & details", "Charges", "Review"];

/**
 * Guided return for one trailer: condition (+damage evidence when there is new
 * damage) → photos and return details → charges → review and confirm. Charges
 * are persisted server-side so a later invoice bills them.
 */
export default function GuidedReturn({ agreementId, item, onClose, onDone }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(() => Object.fromEntries(
    CONDITION_FIELDS.map(([k]) => [k, "Good"]),
  ));
  const [damage, setDamage] = useState({ has: false, description: "", charge: "" });
  const [photos, setPhotos] = useState([]);
  const [damagePhotos, setDamagePhotos] = useState([]);
  const [details, setDetails] = useState({
    actual_return_at: "", return_location: "", trailer_status: "available",
  });
  const [charges, setCharges] = useState([]); // [{type, amount, description}]
  const [discount, setDiscount] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const chargeTotal = charges.reduce((s, c) => s + Number(c.amount || 0), 0)
    + Number(damage.charge || 0);

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      setProgress("Saving return inspection…");
      await ag.saveItemInspection(agreementId, item.id, "return", {
        ...form,
        new_damage: damage.has ? damage.description : "",
      });
      if (photos.length) {
        setProgress("Uploading return photos…");
        await dept.uploadMedia(photos, {
          media_type: "return_condition_photo",
          agreement_id: agreementId, rental_item_id: item.id, trailer_id: item.trailer_id,
        });
        setPhotos([]);
      }
      if (damage.has && damagePhotos.length) {
        setProgress("Uploading damage photos…");
        await dept.uploadMedia(damagePhotos, {
          media_type: "damage_photo",
          agreement_id: agreementId, rental_item_id: item.id, trailer_id: item.trailer_id,
        });
        setDamagePhotos([]);
      }
      setProgress("Completing inspection…");
      await ag.completeItemInspection(agreementId, item.id, "return");
      setProgress("Recording the return…");
      const byType = Object.fromEntries(charges.map((c) => [c.type, Number(c.amount || 0)]));
      const result = await ag.returnItem(agreementId, item.id, {
        actual_return_at: details.actual_return_at
          ? new Date(details.actual_return_at).toISOString() : undefined,
        return_location: details.return_location || null,
        trailer_status: damage.has && details.trailer_status === "available"
          ? "held_damage" : details.trailer_status,
        new_damage: damage.has ? damage.description : undefined,
        damage_charge: Number(damage.charge || 0) || byType.damage_charge || 0,
        cleaning_charge: byType.cleaning_charge || 0,
        late_fee: byType.late_fee || 0,
        other_charge: byType.other_charge || 0,
        discount: Number(discount || 0) || 0,
        description: damage.has
          ? damage.description
          : charges.map((c) => c.description).filter(Boolean).join("; ") || undefined,
        version: item.version,
      });
      onDone(result);
    } catch (e) {
      setError(e.message);
      setBusy(false);
      setProgress("");
    }
  };

  const damageComplete = !damage.has || (damage.description.trim() && damagePhotos.length > 0);

  return (
    <Modal
      title={`Return trailer ${item.unit_number || ""}`}
      subtitle={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
      onClose={busy ? undefined : onClose}
      wide
    >
      {error && <div className="alert alert-danger">{error}</div>}
      {step === 0 && (
        <div>
          <div className="trailer-form-grid">
            {CONDITION_FIELDS.map(([key, label]) => (
              <Field key={key} label={label}>
                <select value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}>
                  {CONDITION_CHOICES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <Field label="Is there new damage?">
            <div className="trailer-actions">
              <label><input type="radio" checked={!damage.has}
                onChange={() => setDamage({ ...damage, has: false })} /> No</label>
              <label><input type="radio" checked={damage.has}
                onChange={() => setDamage({ ...damage, has: true })} /> Yes</label>
            </div>
          </Field>
          {damage.has && (
            <div className="trailer-form-grid">
              <Field label="Describe the damage">
                <textarea value={damage.description} required
                  onChange={(e) => setDamage({ ...damage, description: e.target.value })} />
              </Field>
              <Field label="Damage charge (optional)">
                <input type="number" min="0" step="0.01" value={damage.charge}
                  onChange={(e) => setDamage({ ...damage, charge: e.target.value })} />
              </Field>
              <Field label="Damage photos (at least one)">
                <input type="file" accept="image/*" capture="environment" multiple
                  onChange={(e) => setDamagePhotos([...damagePhotos, ...Array.from(e.target.files || [])])} />
              </Field>
              {damagePhotos.map((f, i) => (
                <div key={i} className="trailer-photo-row">
                  <span>{f.name}</span>
                  <button type="button" className="btn btn-sm btn-ghost"
                    onClick={() => setDamagePhotos(damagePhotos.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {step === 1 && (
        <div className="trailer-form-grid">
          <Field label="Return photos (at least one)">
            <input type="file" accept="image/*" capture="environment" multiple
              onChange={(e) => setPhotos([...photos, ...Array.from(e.target.files || [])])} />
          </Field>
          {Number(item.return_photo_count) > 0 && (
            <p className="trailer-help">{item.return_photo_count} photo(s) already stored.</p>
          )}
          {photos.map((f, i) => (
            <div key={i} className="trailer-photo-row">
              <span>{f.name}</span>
              <button type="button" className="btn btn-sm btn-ghost"
                onClick={() => setPhotos(photos.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <Field label="Actual return time (leave empty for now)">
            <input type="datetime-local" value={details.actual_return_at}
              onChange={(e) => setDetails({ ...details, actual_return_at: e.target.value })} />
          </Field>
          <Field label="Return location">
            <input value={details.return_location}
              onChange={(e) => setDetails({ ...details, return_location: e.target.value })} />
          </Field>
          <Field label="Trailer condition after return">
            <select value={details.trailer_status}
              onChange={(e) => setDetails({ ...details, trailer_status: e.target.value })}>
              {AFTER_RETURN
                .filter(([value]) => !(damage.has && value === "available"))
                .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>
      )}
      {step === 2 && (
        <div>
          <p>Rental charges are computed by the server from the rental window. Add extra charges only if needed.</p>
          {charges.map((c, i) => (
            <div key={i} className="trailer-form-grid trailer-charge-row">
              <Field label="Charge type">
                <select value={c.type}
                  onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                  {CHARGE_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              <Field label="Amount">
                <input type="number" min="0" step="0.01" value={c.amount}
                  onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              </Field>
              <Field label="Description">
                <input value={c.description}
                  onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              </Field>
              <button type="button" className="btn btn-sm btn-ghost"
                onClick={() => setCharges(charges.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn btn-secondary"
            onClick={() => setCharges([...charges, { type: "cleaning_charge", amount: "", description: "" }])}>
            Add another charge
          </button>
          <div className="trailer-form-grid" style={{ marginTop: 12 }}>
            <Field label="Discount (optional)">
              <input type="number" min="0" step="0.01" value={discount}
                onChange={(e) => setDiscount(e.target.value)} />
            </Field>
          </div>
        </div>
      )}
      {step === 3 && (
        <div className="trailer-summary">
          <span>Trailer: <b>{item.unit_number}</b></span>
          <span>New damage: {damage.has ? "yes" : "no"}</span>
          <span>Extra charges: ${chargeTotal.toFixed(2)}</span>
          <span>Condition after return: {AFTER_RETURN.find(([v]) => v === details.trailer_status)?.[1]}</span>
          {!damageComplete && (
            <p className="trailer-help">Damage needs a description and at least one photo before confirming.</p>
          )}
          {progress && <p className="trailer-help">{progress}</p>}
        </div>
      )}
      <div className="trailer-actions" style={{ marginTop: 16 }}>
        {step > 0 && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < STEPS.length - 1 && (
          <button type="button" className="btn btn-primary" disabled={step === 0 && !damageComplete}
            onClick={() => setStep(step + 1)}>
            Next
          </button>
        )}
        {step === STEPS.length - 1 && (
          <button type="button" className="btn btn-primary" disabled={busy || !damageComplete} onClick={confirm}>
            {busy ? progress || "Working…" : "Confirm return"}
          </button>
        )}
      </div>
    </Modal>
  );
}
