import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { nextTrapIndex, isActivationKey } from "./a11y/keys";
export function Card({ children, className = "" }) {
  return (
    <section className={`card trailer-card ${className}`}>{children}</section>
  );
}
export function Alert({ message, onClear }) {
  if (!message) return null;
  const isError = message.type === "error";
  return (
    <div
      className={`alert alert-${isError ? "danger" : "success"}`}
      // Errors interrupt (assertive); success/progress is polite.
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      onClick={onClear}
    >
      {message.text}
    </div>
  );
}
export function Empty({ children = "No records found." }) {
  return <div className="trailer-empty">{children}</div>;
}
export function Status({ value }) {
  const key = String(value || "unknown").replaceAll("_", " ");
  return (
    <span
      className={`trailer-status trailer-status-${String(value || "unknown")}`}
    >
      {key}
    </span>
  );
}
export function Table({ columns, rows, onRow }) {
  return (
    <div className="trailer-table-wrap">
      <table className="trailer-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id || row.unit_number}
              // A clickable row is keyboard-operable: focusable, activates on
              // Enter/Space, and announces itself as a button to assistive tech.
              onClick={onRow ? () => onRow(row) : undefined}
              onKeyDown={onRow ? (e) => {
                if (isActivationKey(e.key)) { e.preventDefault(); onRow(row); }
              } : undefined}
              tabIndex={onRow ? 0 : undefined}
              role={onRow ? "button" : undefined}
              aria-label={onRow ? (row.aria_label || `Open ${row.unit_number || row.invoice_number || row.id || "record"}`) : undefined}
              className={onRow ? "clickable" : ""}
            >
              {columns.map((c) => (
                <td key={c.key}>
                  {c.render ? c.render(row) : (row[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function useLoad(loader, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await loader());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, deps);
  useEffect(() => {
    load();
  }, [load]);
  return { data, loading, error, reload: load, setData };
}
export const Field = ({ label, children }) => (
  <label className="trailer-field">
    <span>{label}</span>
    {children}
  </label>
);
export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="trailer-page-header">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="trailer-actions">{actions}</div>
    </div>
  );
}
/** Focusable descendants of a container, in DOM order, that are visible. */
function focusableWithin(container) {
  if (!container) return [];
  const sel = 'a[href],area[href],button:not([disabled]),input:not([disabled]),'
    + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(sel))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Accessible modal dialog (§8): role="dialog" + aria-modal, labelled by its
 * title, focus moved inside on open and trapped, Escape closes when not busy,
 * and focus is restored to the trigger on close. `onClose` undefined (e.g. while
 * busy) disables both the close button and Escape. Prop API is unchanged from
 * the previous Modal so existing dialogs keep working.
 */
export function Modal({ title, subtitle, onClose, wide, children }) {
  const cardRef = useRef(null);
  const restoreRef = useRef(null);
  const titleId = useId();
  const subId = useId();

  useEffect(() => {
    restoreRef.current = document.activeElement;
    // Move focus into the dialog (first focusable, else the card itself).
    const focusables = focusableWithin(cardRef.current);
    (focusables[0] || cardRef.current)?.focus?.();
    return () => {
      // Restore focus to whatever opened the dialog.
      restoreRef.current?.focus?.();
    };
  }, []);

  const onKeyDown = (e) => {
    if (e.key === "Escape" && onClose) { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const focusables = focusableWithin(cardRef.current);
    if (!focusables.length) { e.preventDefault(); return; }
    const current = focusables.indexOf(document.activeElement);
    const nextIdx = nextTrapIndex(current < 0 ? 0 : current, focusables.length, e.shiftKey);
    // Only intercept when focus would leave the dialog (edges), so normal
    // in-dialog tabbing is untouched.
    const leavingForward = !e.shiftKey && (current === focusables.length - 1 || current < 0);
    const leavingBack = e.shiftKey && (current <= 0);
    if (leavingForward || leavingBack) {
      e.preventDefault();
      focusables[nextIdx].focus();
    }
  };

  return (
    <div className="trailer-modal-backdrop" onMouseDown={(e) => {
      // Click on the backdrop (not the card) closes when allowed.
      if (e.target === e.currentTarget && onClose) onClose();
    }}>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`card trailer-card trailer-modal ${wide ? "trailer-modal-wide" : ""}`}
      >
        <div className="trailer-page-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p id={subId}>{subtitle}</p>}
          </div>
          <div className="trailer-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}
              disabled={!onClose} aria-label="Close dialog">
              Close
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
