import React from "react";

/**
 * Shared form-field components for the Settings tabs.
 * Extracted verbatim from SettingsPage.jsx.
 */

function KeyField({ label, hint, value, onChange, placeholder, fromEnv, type = "password" }) {
  return (
    <div className="form-group">
      <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</label>
      {hint && (
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
          Currently: <strong>{hint}</strong>{fromEnv ? " (from environment)" : ""}
        </div>
      )}
      <input
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
  return (
    <div className="form-group" style={{ marginBottom: 12 }}>
      <label style={{ display: "block", fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
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
