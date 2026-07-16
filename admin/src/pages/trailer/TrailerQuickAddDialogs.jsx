import React, { useState } from "react";
import { Card, Field, PageHeader } from "./TrailerUi";

/**
 * Quick-add overlays for the New Rental Draft.
 *
 * The draft is already a <form>, and a nested form is invalid HTML, so these
 * render as sibling overlays built from plain containers with type="button"
 * controls — nothing here can submit the rental draft.
 */
function QuickAddDialog({ title, children, error, busy, canSave, onSave, onClose, saveLabel }) {
  return (
    <div className="trailer-modal-backdrop trailer-modal-stacked">
      <Card className="trailer-modal trailer-quick-add">
        <PageHeader
          title={title}
          actions={
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          }
        />
        {error && <div className="alert alert-danger">{error}</div>}
        {children}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !canSave}
          onClick={onSave}
        >
          {busy ? "Saving…" : saveLabel}
        </button>
      </Card>
    </div>
  );
}

export function QuickAddTrailerDialog({ onClose, onCreate }) {
  const [unitNumber, setUnitNumber] = useState("");
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(unitNumber.trim());
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <QuickAddDialog
      title="Add trailer"
      saveLabel="Add trailer"
      error={error}
      busy={busy}
      canSave={Boolean(unitNumber.trim()) && verified}
      onSave={save}
      onClose={onClose}
    >
      <Field label="Unit number">
        <input autoFocus value={unitNumber} onChange={(e) => setUnitNumber(e.target.value)} />
      </Field>
      <label className="trailer-check">
        <input
          type="checkbox"
          checked={verified}
          onChange={(e) => setVerified(e.target.checked)}
        />
        I physically verified that this trailer is available
      </label>
      <p className="trailer-help">
        The trailer is created as available, so verification is required before saving.
      </p>
    </QuickAddDialog>
  );
}

export function QuickAddCompanyDialog({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(name.trim());
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <QuickAddDialog
      title="Add renter company"
      saveLabel="Add company"
      error={error}
      busy={busy}
      canSave={Boolean(name.trim())}
      onSave={save}
      onClose={onClose}
    >
      <Field label="Company name">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <p className="trailer-help">
        Saved as both the legal and display name — edit the full record later on the
        Companies page.
      </p>
    </QuickAddDialog>
  );
}
