import React, { useCallback, useEffect, useState } from "react";
import * as api from "../api";

const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function getFileExtension(mimeType) {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "bin";
}

function normalizeClipboardFile(file) {
  if (!file) return null;
  if (file.name) return file;
  return new File(
    [file],
    `clipboard-${Date.now()}.${getFileExtension(file.type)}`,
    { type: file.type || "application/octet-stream" }
  );
}

export default function DispatchPage() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [resultText, setResultText] = useState("");
  const [activeFileName, setActiveFileName] = useState("");
  const [copying, setCopying] = useState(false);

  const uploadFile = useCallback(async (inputFile) => {
    const file = normalizeClipboardFile(inputFile);
    if (!file) return;

    if (!ACCEPTED_MIME_TYPES.has(file.type)) {
      setMessage({ type: "error", text: "Please upload a PDF, JPG, PNG, or WEBP file." });
      return;
    }

    setLoading(true);
    setMessage(null);
    setActiveFileName(file.name);

    try {
      const data = await api.parseDispatchRateCon(file);
      setResultText(data.text || "");
      setMessage({ type: "success", text: "Rate confirmation parsed successfully." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const handlePaste = (event) => {
      if (loading) return;

      const fileItem = Array.from(event.clipboardData?.items || []).find(
        (item) => item.kind === "file"
      );
      if (!fileItem) return;

      const pastedFile = fileItem.getAsFile();
      if (!pastedFile) return;

      event.preventDefault();
      uploadFile(pastedFile);
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [loading, uploadFile]);

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (file) {
      await uploadFile(file);
    }
    event.target.value = "";
  };

  const handleCopy = async () => {
    if (!resultText) return;

    setCopying(true);
    try {
      await navigator.clipboard.writeText(resultText);
      setMessage({ type: "success", text: "Formatted load copied to clipboard." });
    } catch (err) {
      setMessage({ type: "error", text: "Copy failed. Please copy the text manually." });
    } finally {
      setCopying(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>Dispatch Assistant</h2>
        <p>Upload or paste a rate confirmation PDF or image and get a dispatcher-ready template.</p>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.text}
        </div>
      )}

      <div style={{ display: "grid", gap: "24px" }}>
        <div className="card">
          <div style={{ display: "grid", gap: "16px" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Rate Confirmation File</label>
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
              <h3 style={{ marginBottom: "4px" }}>Formatted Dispatch Notes</h3>
              <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
                Review and tweak the output before sending it to the dispatcher.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleCopy}
              disabled={!resultText || copying}
            >
              {copying ? "Copying..." : "Copy to Clipboard"}
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
        </div>
      </div>
    </div>
  );
}
