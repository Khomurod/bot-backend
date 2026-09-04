import React from "react";
import { FAILURE_KIND, classifyFailure } from "../utils/pageFailure";

/**
 * The one place a failure is shown to an admin.
 *
 * It states WHICH kind of failure happened (outdated tab, bug in the section,
 * expired session, missing permission, usage limit, database unreachable,
 * network, server), what it means for their data, and offers only the action
 * that actually helps. The underlying message is always printed: hiding it is
 * what turned a one-line ReferenceError into a week-long mystery.
 *
 * `variant="page"` replaces a section's content; `variant="inline"` is a banner
 * a page keeps above whatever it managed to load — so a failed refresh never
 * gets rendered as an empty list.
 */
export default function PageFailure({ error, where = "", onRetry = null, variant = "page" }) {
  const failure = classifyFailure(error, { where });

  const runAction = () => {
    if (failure.action === "reload") {
      window.location.reload();
      return;
    }
    if (failure.action === "signin") {
      // Drop the dead token so the app renders the login page rather than
      // bouncing through another rejected request.
      try { localStorage.removeItem("token"); } catch (e) { /* private mode */ }
      window.location.assign("/admin");
      return;
    }
    if (onRetry) {
      onRetry();
      return;
    }
    window.location.reload();
  };

  const tone = failure.kind === FAILURE_KIND.PERMISSION ? "#f59e0b" : "#ef4444";

  if (variant === "inline") {
    return (
      <div
        role="alert"
        className="card"
        style={{ borderLeft: `4px solid ${tone}`, marginBottom: 16 }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <strong>{failure.title}</strong>
            <div style={{ fontSize: 13, marginTop: 4 }}>{failure.explanation}</div>
            <FailureDetail technical={failure.technical} />
          </div>
          {failure.actionLabel && (
            <button className="btn btn-ghost" onClick={runAction}>{failure.actionLabel}</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div role="alert" className="card" style={{ borderTop: `3px solid ${tone}`, maxWidth: 760 }}>
      <h3 style={{ marginTop: 0 }}>{failure.title}</h3>
      <p style={{ marginBottom: 12 }}>{failure.explanation}</p>
      <FailureDetail technical={failure.technical} open />
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        {failure.actionLabel && (
          <button className="btn btn-primary" onClick={runAction}>{failure.actionLabel}</button>
        )}
        {failure.action !== "reload" && (
          <button className="btn btn-ghost" onClick={() => window.location.reload()}>
            Reload the app
          </button>
        )}
      </div>
    </div>
  );
}

/** The exact underlying message — visible, copyable, never replaced by a guess. */
function FailureDetail({ technical, open = false }) {
  if (!technical) return null;
  return (
    <details open={open} style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-muted)" }}>
        Technical detail
      </summary>
      <code
        style={{
          display: "block",
          marginTop: 6,
          padding: "8px 10px",
          fontSize: 12,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: "rgba(148, 163, 184, 0.12)",
          borderRadius: 6,
        }}
      >
        {technical}
      </code>
    </details>
  );
}
