import React from "react";

export const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Focus the first control inside `element`, if it has one. */
export function focusFirstIn(element) {
  element?.querySelector(FOCUSABLE)?.focus();
}

/**
 * A modal's keyboard rules. ChangePasswordModal and ConfirmDialog share them.
 *
 *   - When it opens, focus moves to the first control inside.
 *   - When it closes, focus returns to `returnFocusRef` if the caller gave
 *     one, otherwise to whatever had focus when it opened.
 *   - Tab and Shift+Tab stay inside.
 *   - Escape calls `onEscape`. Pass null while the dialog must not be
 *     dismissed, for example while its request is in flight.
 */
export function useModalFocus(dialogRef, { onEscape = null, returnFocusRef = null } = {}) {
  React.useEffect(() => {
    const opener = document.activeElement;
    focusFirstIn(dialogRef.current);
    return () => {
      const target = returnFocusRef?.current || opener;
      if (target?.isConnected && typeof target.focus === "function") target.focus();
    };
    // Runs once per opening: the opener is whatever had focus at that moment.
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        if (onEscape) onEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey && dialog.contains(active) ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dialogRef, onEscape]);
}
