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
const FREE_TEXT = [
  ["brakes", "Brakes"],
  ["existing_damage", "Existing damage"],
  ["missing_equipment", "Missing equipment"],
  ["notes", "Notes"],
];

const STEPS = ["Condition", "Photos", "Details", "Confirm"];

/**
 * Guided pickup for one trailer on a rental: condition checklist → photos →
 * pickup details → confirm. Order matters: answers save as a DRAFT, photos
 * upload with retry, and only then does the server complete the inspection
 * (verifying the stored bytes) and confirm the pickup. A failure at any step
 * leaves everything saved and retryable.
 */
export default function GuidedPickup({ agreementId, item, onClose, onDone }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(() => Object.fromEntries(
    [...CONDITION_FIELDS.map(([k]) => [k, "Good"]), ...FREE_TEXT.map(([k]) => [k, ""])],
  ));
  const [files, setFiles] = useState([]);
  const [uploadedCount, setUploadedCount] = useState(Number(item.pickup_photo_count || 0));
  const [details, setDetails] = useState({
    actual_pickup_at: "", pickup_location: item.pickup_location || "",
  });
  const [advanced, setAdvanced] = useState(false);
  const [coords, setCoords] = useState({ lat: "", lng: "" });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      setProgress("Saving inspection…");
      await ag.saveItemInspection(agreementId, item.id, "pickup", {
        ...form,
        inspected_at: details.actual_pickup_at
          ? new Date(details.actual_pickup_at).toISOString() : undefined,
      });
      if (files.length) {
        setProgress(`Uploading ${files.length} photo${files.length > 1 ? "s" : ""}…`);
        await dept.uploadMedia(files, {
          media_type: "pickup_condition_photo",
          agreement_id: agreementId,
          rental_item_id: item.id,
          trailer_id: item.trailer_id,
        });
        setUploadedCount((c) => c + files.length);
        setFiles([]);
      }
      setProgress("Completing inspection…");
      await ag.completeItemInspection(agreementId, item.id, "pickup");
      setProgress("Confirming pickup…");
      const result = await ag.activateItem(agreementId, item.id, item.version);
      onDone(result);
    } catch (e) {
      setError(e.message);
      setBusy(false);
      setProgress("");
    }
  };

  const canConfirm = (uploadedCount > 0 || files.length > 0)
    && CONDITION_FIELDS.every(([k]) => String(form[k] || "").trim());

  return (
    <Modal
      title={`Confirm pickup — trailer ${item.unit_number || ""}`}
      subtitle={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
      onClose={busy ? undefined : onClose}
      wide
    >
      {error && <div className="alert alert-danger">{error}</div>}
      {step === 0 && (
        <div className="trailer-form-grid">
          {CONDITION_FIELDS.map(([key, label]) => (
            <Field key={key} label={label}>
              <select value={form[key]} onChange={(e) => set({ [key]: e.target.value })}>
                {CONDITION_CHOICES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
          ))}
          {FREE_TEXT.map(([key, label]) => (
            <Field key={key} label={`${label} (optional)`}>
              <input value={form[key]} onChange={(e) => set({ [key]: e.target.value })} />
            </Field>
          ))}
        </div>
      )}
      {step === 1 && (
        <div>
          <p>Add at least one photo of the trailer at pickup. You can use the camera or choose files.</p>
          <Field label="Pickup photos">
            <input
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              onChange={(e) => setFiles([...files, ...Array.from(e.target.files || [])])}
            />
          </Field>
          {uploadedCount > 0 && (
            <p className="trailer-help">{uploadedCount} photo{uploadedCount > 1 ? "s" : ""} already stored.</p>
          )}
          {files.map((f, i) => (
            <div key={i} className="trailer-photo-row">
              <span>{f.name}</span>
              <button type="button" className="btn btn-sm btn-ghost"
                onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {step === 2 && (
        <div className="trailer-form-grid">
          <Field label="Actual pickup time (leave empty for the planned time)">
            <input
              type="datetime-local"
              value={details.actual_pickup_at}
              onChange={(e) => setDetails({ ...details, actual_pickup_at: e.target.value })}
            />
          </Field>
          <Field label="Pickup location">
            <input
              value={details.pickup_location}
              onChange={(e) => setDetails({ ...details, pickup_location: e.target.value })}
            />
          </Field>
          <button type="button" className="btn btn-link" onClick={() => setAdvanced(!advanced)}>
            {advanced ? "Hide advanced options" : "Advanced options"}
          </button>
          {advanced && (
            <>
              <Field label="Latitude">
                <input value={coords.lat} onChange={(e) => setCoords({ ...coords, lat: e.target.value })} />
              </Field>
              <Field label="Longitude">
                <input value={coords.lng} onChange={(e) => setCoords({ ...coords, lng: e.target.value })} />
              </Field>
            </>
          )}
        </div>
      )}
      {step === 3 && (
        <div className="trailer-summary">
          <span>Trailer: <b>{item.unit_number}</b></span>
          <span>Condition recorded: {CONDITION_FIELDS.map(([k]) => form[k]).filter((v) => v !== "Good").length
            ? "some items need attention" : "all good"}</span>
          <span>Photos: {uploadedCount + files.length}</span>
          <span>Pickup: {details.actual_pickup_at || "planned time"}</span>
          {!canConfirm && (
            <p className="trailer-help">
              The confirm button unlocks once every condition field is answered and at least one photo is added.
            </p>
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
          <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>
            Next
          </button>
        )}
        {step === STEPS.length - 1 && (
          <button type="button" className="btn btn-primary" disabled={busy || !canConfirm} onClick={confirm}>
            {busy ? progress || "Working…" : "Confirm pickup"}
          </button>
        )}
      </div>
    </Modal>
  );
}
