import React from "react";

/**
 * The ETA on/off switch.
 *
 * It renders as a real <button> with aria-pressed rather than a styled div, so
 * it is reachable by keyboard and announced correctly — these toggles start and
 * stop messages going to real driver groups.
 *
 * Split out of admin/src/pages/DispatchPage.jsx.
 */
export function ToggleSwitch({ label, checked, onToggle, disabled, saving, title, ariaLabel }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onToggle}
      disabled={disabled}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        border: "none",
        background: "transparent",
        color: "var(--text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
        opacity: disabled && !saving ? 0.6 : 1,
      }}
    >
      <span style={{ fontSize: "12px" }}>{label}</span>
      <span
        style={{
          width: "42px",
          height: "24px",
          borderRadius: "999px",
          background: checked ? "var(--success)" : "var(--border)",
          position: "relative",
          transition: "background 150ms ease",
          opacity: saving ? 0.7 : 1,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "3px",
            left: checked ? "21px" : "3px",
            width: "18px",
            height: "18px",
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 150ms ease",
          }}
        />
      </span>
      {saving && checked ? "Saving..." : (checked ? "On" : "Off")}
    </button>
  );
}
