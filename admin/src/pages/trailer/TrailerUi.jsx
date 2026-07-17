import React, { useCallback, useEffect, useState } from "react";
export function Card({ children, className = "" }) {
  return (
    <section className={`card trailer-card ${className}`}>{children}</section>
  );
}
export function Alert({ message, onClear }) {
  if (!message) return null;
  return (
    <div
      className={`alert alert-${message.type === "error" ? "danger" : "success"}`}
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
              onClick={() => onRow?.(row)}
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
export function Modal({ title, subtitle, onClose, wide, children }) {
  return (
    <div className="trailer-modal-backdrop">
      <Card className={`trailer-modal ${wide ? "trailer-modal-wide" : ""}`}>
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          }
        />
        {children}
      </Card>
    </div>
  );
}
