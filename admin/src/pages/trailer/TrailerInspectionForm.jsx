import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { Card, Field, Alert } from "./TrailerUi";

/**
 * Pickup / return inspection.
 *
 * The order here is the whole point. It used to save the inspection as
 * COMPLETE and only then upload the photos, so a failed upload left a
 * "completed" inspection with no photo — which then blocked activation with a
 * confusing error and no way back.
 *
 * Now:  save a draft  ->  upload photos  ->  ask the backend to complete.
 *
 * The backend verifies the photo's bytes really exist before completing, so a
 * failure at any step leaves an incomplete-but-saved inspection. Answers stay
 * on screen, already-uploaded photos are remembered, and the user retries
 * without re-entering anything or recreating the rental.
 */

const INSPECTION_FIELDS = [
  "overall_condition",
  "tires",
  "lights",
  "doors",
  "roof",
  "floor",
  "exterior",
  "interior",
  "landing_gear",
  "brakes",
  "existing_damage",
  "new_damage",
  "missing_equipment",
  "notes",
];
const FREE_TEXT = ["brakes", "existing_damage", "new_damage", "missing_equipment", "notes"];

export default function Inspection({ rental, type, onDone }) {
  const [form, setForm] = useState(
    Object.fromEntries(
      INSPECTION_FIELDS.map((key) => [key, FREE_TEXT.includes(key) ? "" : "Good"]),
    ),
  );
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(null);
  const [error, setError] = useState(null);
  // Photos already stored on the server. Kept across a failed retry so a second
  // attempt never re-uploads what already landed.
  const [uploaded, setUploaded] = useState([]);

  const photoType = type === "pickup" ? "pickup_condition_photo" : "return_condition_photo";
  const label = type === "pickup" ? "Pickup" : "Return";

  const submit = async () => {
    setError(null);
    if (!files.length && !uploaded.length) {
      setError({ type: "error", text: `At least one ${type} photo is required.` });
      return;
    }
    setBusy(true);
    try {
      // 1. Draft first. The backend ignores any completion request here.
      setStep("Saving inspection…");
      const { inspection } = await api.saveInspection(rental.id, type, form);

      // 2. Photos next, and only what is not already stored.
      if (files.length) {
        setStep(`Uploading ${files.length} photo${files.length > 1 ? "s" : ""}…`);
        const { media } = await api.uploadMedia(files, {
          media_type: photoType,
          rental_id: rental.id,
          trailer_id: rental.trailer_id,
          inspection_id: inspection.id,
        });
        setUploaded((current) => [...current, ...(media || [])]);
        setFiles([]);
      }

      // 3. Only now may it complete — and the backend re-checks the bytes.
      setStep("Completing inspection…");
      const completed = await api.completeInspection(rental.id, type);
      onDone?.(completed.inspection);
    } catch (e) {
      // Show what actually went wrong and keep everything on screen to retry.
      setError({
        type: "error",
        text: e?.message || "The inspection could not be completed. Nothing was lost — try again.",
      });
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  return (
    <Card>
      <h3>{label} inspection</h3>
      <Alert message={error} onClear={() => setError(null)} />
      <div className="trailer-form-grid">
        {INSPECTION_FIELDS.map((key) => (
          <Field key={key} label={key.replaceAll("_", " ")}>
            <input
              value={form[key]}
              disabled={busy}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </Field>
        ))}
        <Field label={`${label} photos (at least one required)`}>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            disabled={busy}
            onChange={(e) => setFiles([...e.target.files])}
          />
        </Field>
      </div>

      {uploaded.length > 0 && (
        <p className="trailer-help">
          {uploaded.length} photo{uploaded.length > 1 ? "s" : ""} already uploaded
          {files.length > 0 ? " — only the newly selected files will be sent." : "."}
        </p>
      )}

      <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
        {busy ? step || "Processing…" : "Complete inspection and upload"}
      </button>
    </Card>
  );
}

export { INSPECTION_FIELDS };
