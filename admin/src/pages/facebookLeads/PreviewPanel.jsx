import React from "react";

/**
 * One rendered-message preview: the text as the lead will receive it, which
 * rule produced it, and the SMS segment count.
 *
 * The segment count is the point of showing this at all — a template that
 * spills past 160 characters is billed and delivered as multiple messages, so
 * an admin needs to see it before saving, not after a send.
 *
 * Split out of admin/src/pages/FacebookLeadsPage.jsx.
 */
export function PreviewPanel({ title, subtitle, preview, emptyText = "(empty)" }) {
  const charCount = preview?.segments?.length ?? 0;
  const segmentCount = preview?.segments?.segments ?? 1;

  return (
    <div className="card" style={{ padding: 16, flex: 1, minWidth: 280 }}>
      <h3 style={{ marginTop: 0, marginBottom: 4 }}>{title}</h3>
      {subtitle && (
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "#94a3b8" }}>{subtitle}</p>
      )}
      {preview?.error ? (
        <p style={{ color: "#ef4444", fontSize: 13 }}>{preview.error}</p>
      ) : preview ? (
        <>
          <p style={{ margin: "4px 0", fontSize: 13, color: "#94a3b8" }}>
            Would use: <strong>{preview.rule_label || "—"}</strong>
            {charCount > 0 && (
              <>
                {" · "}{charCount} chars
                {segmentCount > 1 ? ` (${segmentCount} SMS segments)` : ""}
                {charCount > 320 ? " — long message (multipart SMS)" : ""}
              </>
            )}
          </p>
          <pre style={{ whiteSpace: "pre-wrap", background: "#0f172a", padding: 12, borderRadius: 8, margin: 0 }}>
            {preview.rendered || emptyText}
          </pre>
        </>
      ) : (
        <p style={{ color: "#94a3b8", fontSize: 13 }}>Loading preview…</p>
      )}
    </div>
  );
}
