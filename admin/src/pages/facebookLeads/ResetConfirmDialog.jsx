import React from "react";

/**
 * "Discard unsaved changes?" — the confirm before reloading settings from the
 * server.
 *
 * It exists because the rule editor holds a draft that is never autosaved: a
 * plain Reset button would throw away work with no way back.
 *
 * Split out of admin/src/pages/FacebookLeadsPage.jsx.
 */
export function ResetConfirmDialog({ setShowResetConfirm, confirmReset }) {
  return (

  <div className="confirm-overlay" onClick={() => setShowResetConfirm(false)}>
    <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
      <h3>Discard unsaved changes?</h3>
      <p>This will reload all settings from the server. Any edits you haven't saved will be lost.</p>
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary" onClick={() => setShowResetConfirm(false)}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" onClick={confirmReset}>
          Discard changes
        </button>
      </div>
    </div>
  </div>
  );
}
