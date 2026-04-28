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

function formatGroupLabel(group) {
  const driverName = [group.driver_first_name, group.driver_last_name]
    .filter(Boolean)
    .join(" ");
  const namePart = driverName
    ? `${group.group_name} - ${driverName}`
    : group.group_name;
  return `${namePart} | ${group.telegram_group_id}`;
}

function stripRateLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^Rate:\s*/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveChatId(groupInput, groups) {
  const trimmed = String(groupInput || "").trim();
  if (!trimmed) return "";

  const exactMatch = groups.find(
    (group) =>
      group.label === trimmed ||
      group.group_name === trimmed ||
      String(group.telegram_group_id || "") === trimmed
  );
  if (exactMatch) {
    return String(exactMatch.telegram_group_id || "").trim();
  }

  const idMatch = trimmed.match(/(@[A-Za-z0-9_]+|-?\d+)\s*$/);
  return idMatch ? idMatch[1] : trimmed;
}

export default function DispatchPage() {
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(null);
  const [resultText, setResultText] = useState("");
  const [activeFileName, setActiveFileName] = useState("");
  const [sourceFile, setSourceFile] = useState(null);
  const [copying, setCopying] = useState(false);
  const [groups, setGroups] = useState([]);
  const [selectedGroupInput, setSelectedGroupInput] = useState("");
  const [withRate, setWithRate] = useState(true);
  const [withRateConfirmation, setWithRateConfirmation] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const loadGroups = async () => {
      try {
        const data = await api.getGroups();
        if (!isMounted) return;

        const rawGroups = Array.isArray(data) ? data : Array.isArray(data?.groups) ? data.groups : [];
        const managementGroupId = Array.isArray(data)
          ? ""
          : String(data?.managementGroupId || "").trim();

        const managementGroup = {
          id: "management-group",
          group_name: "Management Group",
          telegram_group_id: managementGroupId,
          driver_first_name: "",
          driver_last_name: "",
          label: managementGroupId
            ? `Management Group | ${managementGroupId}`
            : "Management Group | Paste chat ID manually",
        };

        const mappedGroups = rawGroups.map((group) => ({
          ...group,
          label: formatGroupLabel(group),
        }));

        const uniqueGroups = mappedGroups.filter(
          (group) => String(group.telegram_group_id || "") !== managementGroupId
        );
        const nextGroups = [managementGroup, ...uniqueGroups];

        setGroups(nextGroups);
        setSelectedGroupInput((current) => (
          current || (managementGroupId ? managementGroup.label : current)
        ));
      } catch (err) {
        if (!isMounted) return;
        setGroups([
          {
            id: "management-group",
            group_name: "Management Group",
            telegram_group_id: "",
            driver_first_name: "",
            driver_last_name: "",
            label: "Management Group | Paste chat ID manually",
          },
        ]);
      }
    };

    loadGroups();
    return () => {
      isMounted = false;
    };
  }, []);

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
    setSourceFile(file);

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

  const handleSendToTelegram = async () => {
    const chatId = resolveChatId(selectedGroupInput, groups);
    if (!chatId) {
      setMessage({ type: "error", text: "Select a group from the list or paste a valid Telegram chat ID." });
      return;
    }

    let finalText = resultText.trim();
    if (!finalText) {
      setMessage({ type: "error", text: "There is no parsed load text to send yet." });
      return;
    }

    if (!withRate) {
      finalText = stripRateLine(finalText);
    }

    const formData = new FormData();
    formData.append("chatId", chatId);
    formData.append("messageText", finalText);
    if (withRateConfirmation && sourceFile) {
      formData.append("document", sourceFile);
    }

    setSending(true);
    setMessage(null);

    try {
      await api.sendDispatchToTelegram(formData);
      setMessage({ type: "success", text: "Dispatch load sent to Telegram successfully." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSending(false);
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

          <div style={{ display: "grid", gap: "16px", marginTop: "24px" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Telegram Group</label>
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
                With Rate
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
                <input
                  type="checkbox"
                  checked={withRateConfirmation}
                  onChange={(event) => setWithRateConfirmation(event.target.checked)}
                />
                With Rate Confirmation
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn btn-success"
                onClick={handleSendToTelegram}
                disabled={sending || !resultText.trim()}
              >
                {sending ? "Sending..." : "Send to Telegram"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
