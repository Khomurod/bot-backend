import React, { useMemo, useState } from "react";
import { Alert, Field, Modal } from "../TrailerUi";

const TITLES = {
  linked: "Link to an existing trailer",
  created: "Add as a new trailer",
  ignored: "Ignore this message",
  false_detection: "Not a trailer message",
};

const BUTTONS = {
  linked: "Link trailer",
  created: "Add trailer and link",
  ignored: "Ignore message",
  false_detection: "Mark as not a trailer message",
};

/**
 * Resolves one unknown trailer message.
 *
 * - "linked" uses a SEARCHABLE trailer picker (type part of the unit number) —
 *   never a numeric id.
 * - "created" opens the manual trailer-creation form inline; the server creates
 *   the trailer through the normal permission-gated path and links the message
 *   in the same request.
 * Form state is kept on error and submit is disabled while in flight.
 */
export default function MentionResolveDialog({ mention, action, trailers, onClose, onSubmit }) {
  const [search, setSearch] = useState("");
  const [trailerId, setTrailerId] = useState("");
  const [note, setNote] = useState("");
  const [newTrailer, setNewTrailer] = useState({
    unit_number: mention.normalized_unit_number || mention.raw_unit_number || "",
    type: "", plate_number: "", vin: "", notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const matches = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return trailers.slice(0, 8);
    return trailers.filter((t) => String(t.unit_number).toUpperCase().includes(q)).slice(0, 8);
  }, [search, trailers]);

  const needsTrailer = action === "linked";
  const creating = action === "created";
  const canSubmit = !busy
    && (!needsTrailer || trailerId)
    && (!creating || newTrailer.unit_number.trim());

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        review_status: action,
        linked_trailer_id: needsTrailer ? Number(trailerId) : null,
        new_trailer: creating
          ? { ...newTrailer, unit_number: newTrailer.unit_number.trim().toUpperCase(), needs_review: false }
          : undefined,
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
      subtitle={`Message number: ${mention.normalized_unit_number || mention.raw_unit_number || "—"}`}
      onClose={busy ? undefined : onClose}
    >
      {error && <Alert message={{ type: "error", text: error }} />}
      <form onSubmit={submit}>
        {needsTrailer && (
          <>
            <Field label="Search for the trailer">
              <input
                autoFocus
                placeholder="Type part of the unit number…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setTrailerId(""); }}
              />
            </Field>
            <div className="trailer-picker-list" role="listbox" aria-label="Matching trailers">
              {matches.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={String(trailerId) === String(t.id)}
                  className={`trailer-picker-option ${String(trailerId) === String(t.id) ? "active" : ""}`}
                  onClick={() => setTrailerId(t.id)}
                >
                  <b>{t.unit_number}</b>
                  <span>{t.type || ""} {t.current_company_name ? `· rented to ${t.current_company_name}` : ""}</span>
                </button>
              ))}
              {!matches.length && <p className="trailer-empty-line">No trailers match that search.</p>}
            </div>
          </>
        )}
        {creating && (
          <div className="trailer-form-grid">
            <Field label="Unit number">
              <input required value={newTrailer.unit_number}
                onChange={(e) => setNewTrailer({ ...newTrailer, unit_number: e.target.value })} />
            </Field>
            <Field label="Type (optional)">
              <input value={newTrailer.type}
                onChange={(e) => setNewTrailer({ ...newTrailer, type: e.target.value })} />
            </Field>
            <Field label="Plate number (optional)">
              <input value={newTrailer.plate_number}
                onChange={(e) => setNewTrailer({ ...newTrailer, plate_number: e.target.value })} />
            </Field>
            <Field label="VIN (optional)">
              <input value={newTrailer.vin}
                onChange={(e) => setNewTrailer({ ...newTrailer, vin: e.target.value })} />
            </Field>
          </div>
        )}
        <Field label="Note (optional)">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
          {busy ? "Saving…" : BUTTONS[action]}
        </button>
      </form>
    </Modal>
  );
}
