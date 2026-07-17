import React, { useState } from "react";
import { Alert, Field, Modal } from "../TrailerUi";

const TITLES = {
  linked: "Link mention to trailer",
  created: "Record manual creation",
  ignored: "Ignore mention",
  false_detection: "Mark as false detection",
};

/**
 * Resolves one unmatched mention. The backend records the outcome under
 * `review_status`; only "linked" requires a trailer to link to. Form state is
 * kept on error and submit is disabled while the request is in flight.
 */
export default function MentionResolveDialog({ mention, action, trailers, onClose, onSubmit }) {
  const [trailerId, setTrailerId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const needsTrailer = action === "linked";
  const canSubmit = (!needsTrailer || trailerId) && !busy;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        review_status: action,
        linked_trailer_id: needsTrailer ? Number(trailerId) : null,
        review_note: note.trim() || null,
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={TITLES[action]}
      subtitle={mention.normalized_unit_number}
      onClose={onClose}
    >
      {error && <Alert message={{ type: "error", text: error }} />}
      <form onSubmit={submit}>
        {needsTrailer && (
          <Field label="Trailer to link">
            <select
              required
              value={trailerId}
              onChange={(e) => setTrailerId(e.target.value)}
            >
              <option value="">Select…</option>
              {trailers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.unit_number}
                </option>
              ))}
            </select>
          </Field>
        )}
        {action === "created" && (
          <p className="trailer-help">
            Records that a trailer was created manually for this mention. Create the
            trailer itself from the Trailers page — this only closes the review.
          </p>
        )}
        <Field label="Review note (optional)">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
          {busy ? "Saving…" : TITLES[action]}
        </button>
      </form>
    </Modal>
  );
}
