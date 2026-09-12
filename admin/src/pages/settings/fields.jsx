import React from "react";

/**
 * Shared form-field components for the Settings tabs.
 * Extracted verbatim from SettingsPage.jsx.
 *
 * Each label is tied to its input by `htmlFor`/`id`. It was not: the label sat
 * beside the field rather than owning it, so a screen reader announced an
 * unnamed password box and a test could not ask for a field by the name a
 * person sees. The id is derived from the label so callers need not invent one.
 */

/** A stable DOM id from a human label. */
function fieldId(label, prefix) {
  return `${prefix}-${String(label || "field").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function KeyField({ label, hint, value, onChange, placeholder, fromEnv, type = "password" }) {
  const id = fieldId(label, "key");
  return (
    <div className="form-group">
      <label htmlFor={id} style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</label>
      {hint && (
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
          Currently: <strong>{hint}</strong>{fromEnv ? " (from environment)" : ""}
        </div>
      )}
      <input
        id={id}
        className="form-input"
        type={type}
        autoComplete="new-password"
        value={value}
        placeholder={placeholder || "Leave blank to keep current"}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function NumField({ label, value, onChange, suffix }) {
  const id = fieldId(label, "num");
  return (
    <div className="form-group" style={{ marginBottom: 12 }}>
      <label htmlFor={id} style={{ display: "block", fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          id={id}
          className="form-input"
          type="number"
          style={{ maxWidth: 140 }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span style={{ fontSize: 12, color: "#94a3b8" }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Banner({ message }) {
  if (!message) return null;
  return <div className={`alert alert-${message.type === "error" ? "error" : "success"}`}>{message.text}</div>;
}

export { KeyField, NumField, Banner };
