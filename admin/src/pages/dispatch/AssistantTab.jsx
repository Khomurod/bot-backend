import React from "react";

/**
 * Send Load: pick a group, upload or paste a rate confirmation, review the
 * parsed text, and send it.
 *
 * The parsed text stays EDITABLE before sending — the parser is good but the
 * text goes to a driver as-is, so a dispatcher gets the last word.
 *
 * "With rate" and "with rate confirmation" are separate switches because they
 * disclose different things: the dollar figure in the message body, and the
 * original document as an attachment.
 *
 * Split out of admin/src/pages/DispatchPage.jsx.
 */
export function AssistantTab(p) {
  const {
    loading, sending, resultText, setResultText, activeFileName,
    copying, groups, selectedGroupInput, setSelectedGroupInput,
    withRate, setWithRate, withRateConfirmation, setWithRateConfirmation,
    handleFileChange, handleCopy, handleSendToTelegram,
  } = p;

  return (

  <div style={{ display: "grid", gap: "24px" }}>
    <div className="card">
      <div style={{ display: "grid", gap: "16px" }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Upload Rate Confirmation</label>
          <input
            type="file"
            className="form-input"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            onChange={handleFileChange}
            disabled={loading}
          />
        </div>

        <div
          style={{
            padding: "14px 16px",
            borderRadius: "12px",
            border: "1px dashed var(--border)",
            background: "var(--bg-secondary)",
            color: "var(--text-secondary)",
            lineHeight: 1.5,
          }}
        >
          Press <strong>Ctrl+V</strong> anywhere on this page to upload a copied screenshot, picture, or PDF from your clipboard automatically.
        </div>

        {activeFileName && (
          <div style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
            Current file: <strong style={{ color: "var(--text-primary)" }}>{activeFileName}</strong>
          </div>
        )}

        {loading && (
          <div className="loading" style={{ padding: "12px 0", justifyContent: "flex-start" }}>
            <div className="spinner"></div>
            Extracting text and formatting the load...
          </div>
        )}
      </div>
    </div>

    <div className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "12px",
          marginBottom: "16px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3 style={{ marginBottom: "4px" }}>Load Details</h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
            Review and edit before sending to the driver group.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleCopy}
          disabled={!resultText || copying}
        >
          {copying ? "Copying..." : "📋 Copy"}
        </button>
      </div>

      <textarea
        className="form-textarea"
        value={resultText}
        onChange={(event) => setResultText(event.target.value)}
        placeholder="The formatted load template will appear here after processing."
        style={{
          minHeight: "420px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          whiteSpace: "pre-wrap",
        }}
      />

      <div style={{ display: "grid", gap: "16px", marginTop: "24px" }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Driver Group</label>
          <input
            type="text"
            className="form-input"
            list="dispatch-group-options"
            value={selectedGroupInput}
            onChange={(event) => setSelectedGroupInput(event.target.value)}
            placeholder="Search a group name or paste a chat ID"
          />
          <datalist id="dispatch-group-options">
            {groups.map((group) => (
              <option key={group.id || group.label} value={group.label} />
            ))}
          </datalist>
        </div>

        <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={withRate}
              onChange={(event) => setWithRate(event.target.checked)}
            />
            Include rate amount
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={withRateConfirmation}
              onChange={(event) => setWithRateConfirmation(event.target.checked)}
            />
            Attach document
          </label>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn-success"
            onClick={handleSendToTelegram}
            disabled={sending || !resultText.trim()}
          >
            {sending ? "Sending..." : "📤 Send to Driver"}
          </button>
        </div>
      </div>
    </div>
  </div>
  );
}
