import React from "react";

/**
 * The page's single status banner.
 *
 * It renders a `details` array when one is present because a Route Control
 * action can partly succeed — a route assigned but its Telegram delivery
 * failing, say — and collapsing that to one line hides the half that needs
 * attention.
 *
 * Split out of admin/src/pages/RouteControlPage.jsx.
 */
export function Banner({ message }) {
  if (!message) return null;
  const type = message.type === "error" ? "error" : message.type === "warning" ? "warning" : "success";
  const details = Array.isArray(message.details) ? message.details : null;
  return (
    <div className={`alert alert-${type}`}>
      <div>{message.text}</div>
      {details && details.length > 0 && (
        <dl style={{ margin: "8px 0 0", display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", fontSize: 12 }}>
          {details.map((d) => (
            <React.Fragment key={d.label}>
              <dt style={{ fontWeight: 600, opacity: 0.8 }}>{d.label}</dt>
              <dd style={{ margin: 0, fontFamily: d.label === "Reference" ? "monospace" : "inherit", wordBreak: "break-word" }}>{d.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}
