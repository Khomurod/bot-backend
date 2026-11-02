import React from "react";

import { useModalFocus } from "./useModalFocus";

/**
 * "Are you sure?" before an action that cannot be taken back: a post to a
 * Telegram group, a delete.
 *
 * Screen readers announce it as a modal dialog under its own title. Focus
 * starts on Cancel, so pressing Enter by reflex does nothing harmful. Tab
 * stays inside, and Escape or a click outside cancels. On close, focus goes
 * back to the button that opened it, or to `fallbackFocusRef` when that
 * button is disabled by the action it confirmed.
 */
export default function ConfirmDialog({
  title, children, confirmLabel = "Confirm", danger = false, onConfirm, onCancel, fallbackFocusRef = null,
}) {
  const dialogRef = React.useRef(null);
  const titleId = React.useId();
  useModalFocus(dialogRef, { onEscape: onCancel, fallbackFocusRef });

  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div
        ref={dialogRef} className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId}>{title}</h3>
        <p>{children}</p>
        <div className="confirm-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className={danger ? "btn btn-danger" : "btn btn-primary"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
