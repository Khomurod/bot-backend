import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { nextTrapIndex, isActivationKey } from "./a11y/keys";
import {
  totalPages as calcTotalPages, activeFilterCount, parseListParams,
  serializeListParams, withFilterChange,
} from "./a11y/listQuery";
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
/**
 * Server-pagination controls (§10). Shows the total result count and page
 * position; Prev/Next are disabled at the ends. Buttons have accessible names.
 */
export function Pagination({ page, pageSize, total, onPage }) {
  const pages = calcTotalPages(total, pageSize);
  if (!total) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <nav className="trailer-pagination" aria-label="Pagination" role="navigation">
      <span className="trailer-pagination-total" aria-live="polite">
        {total === 1 ? "1 result" : `${total} results`} · showing {from}–{to}
      </span>
      <div className="trailer-actions">
        <button type="button" className="btn btn-sm btn-secondary" aria-label="Previous page"
          disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span aria-current="page">Page {page} of {pages}</span>
        <button type="button" className="btn btn-sm btn-secondary" aria-label="Next page"
          disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </nav>
  );
}

/**
 * URL-persisted list state: filters + paging synced to the query string, with
 * a debounced text search. Returns the current filters, setters, and the active
 * filter count. `allowed` lists the filter keys this list understands.
 */
export function useUrlList(allowed, defaults = {}) {
  const read = useCallback(
    () => ({ page: 1, page_size: 25, ...defaults, ...parseListParams(window.location.search, allowed) }),
    [],
  );
  const [filters, setFilters] = useState(read);

  const sync = useCallback((next) => {
    const url = new URL(window.location.href);
    url.search = serializeListParams(next);
    window.history.replaceState({}, "", url);
    setFilters(next);
  }, []);

  useEffect(() => {
    const onPop = () => setFilters(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [read]);

  const setFilter = useCallback((patch) => sync(withFilterChange(filters, patch)), [filters, sync]);
  const setPage = useCallback((page) => sync({ ...filters, page }), [filters, sync]);
  const clearAll = useCallback(() => sync({ page: 1, page_size: filters.page_size, ...defaults }), [filters, sync]);

  return {
    filters,
    setFilter,
    setPage,
    clearAll,
    activeCount: activeFilterCount(filters),
  };
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
/**
 * Focusable descendants of a container, in DOM order. Hidden/disabled elements
 * are excluded via attributes rather than layout (offsetParent), so the same
 * logic works in the browser AND in jsdom component tests, which never lay out.
 */
function focusableWithin(container) {
  if (!container) return [];
  const sel = 'a[href],area[href],button:not([disabled]),input:not([disabled]),'
    + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(sel))
    .filter((el) => !el.closest('[hidden]') && el.getAttribute('aria-hidden') !== 'true');
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
    // Move focus into the dialog: prefer the first control in the BODY (so a
    // screen reader doesn't announce "Close" first), else the close button,
    // else the card itself.
    const focusables = focusableWithin(cardRef.current);
    const preferred = focusables.find((el) => !el.closest("[data-modal-header]")) || focusables[0];
    (preferred || cardRef.current)?.focus?.();
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
        <div className="trailer-page-header" data-modal-header>
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
