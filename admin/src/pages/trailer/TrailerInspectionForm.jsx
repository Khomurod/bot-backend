import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { Card, Field } from "./TrailerUi";

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
  const submit = async () => {
    setBusy(true);
    try {
      const { inspection } = await api.saveInspection(rental.id, type, {
        ...form,
        completed: true,
      });
      if (!files.length) throw new Error("Select at least one condition photo.");
      await api.uploadMedia(files, {
        media_type: type === "pickup" ? "pickup_condition_photo" : "return_condition_photo",
        rental_id: rental.id,
        trailer_id: rental.trailer_id,
        inspection_id: inspection.id,
      });
      onDone?.(inspection);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <h3>{type === "pickup" ? "Pickup" : "Return"} inspection</h3>
      <div className="trailer-form-grid">
        {INSPECTION_FIELDS.map((key) => (
          <Field key={key} label={key.replaceAll("_", " ")}>
            <input
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </Field>
        ))}
        <Field label="Condition photos">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={(e) => setFiles([...e.target.files])}
          />
        </Field>
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
        {busy ? "Processing…" : "Complete inspection and upload"}
      </button>
    </Card>
  );
}

export { INSPECTION_FIELDS };
