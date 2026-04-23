import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";

export function getDaysUntilBirthday(dateString) {
  const bd = new Date(dateString);
  const now = new Date();
  let next = new Date(Date.UTC(now.getUTCFullYear(), bd.getUTCMonth(), bd.getUTCDate()));
  if (next < now && next.getUTCDate() !== now.getUTCDate()) {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  }
  return Math.ceil((next - now) / (1000 * 60 * 60 * 24));
}

export const TelegramPreview = React.memo(function TelegramPreview({ text, buttons, label, langTabs, mediaItems, mediaPosition }) {
  const [tab, setTab] = useState(langTabs ? "en" : null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (langTabs && !langTabs.includes(tab)) setTab(langTabs[0]);
  }, [langTabs, tab]);

  if (!mounted) return null;

  const content = (text && typeof text === "object")
    ? (text[tab] || "")
    : (text || "");

  const getMediaElement = (item, style) => {
    if (item.type === "photo") {
      return <img src={item.url} alt="attachment" style={{ ...style, objectFit: "cover" }} />;
    }
    if (item.type === "video") {
      return (
        <video style={{ ...style, objectFit: "cover", background: "#000" }} controls preload="metadata">
          <source src={item.url} type="video/mp4" />
        </video>
      );
    }
    return null;
  };

  const renderMedia = () => {
    if (!mediaItems || mediaItems.length === 0) return null;

    if (mediaItems.length === 1) {
      return (
        <div style={{ width: "100%", maxHeight: 300, overflow: "hidden", display: "flex", justifyContent: "center", background: "#f0f0f0" }}>
          {getMediaElement(mediaItems[0], { maxWidth: "100%", maxHeight: 300 })}
        </div>
      );
    }

    // Grid for 2+ items
    const gridStyle = {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 2,
      maxHeight: 400,
      overflow: "hidden"
    };

    return (
      <div style={gridStyle}>
        {mediaItems.slice(0, 4).map((m, i) => (
          <div key={i} style={{ position: "relative", width: "100%", aspectRatio: "1" }}>
            {getMediaElement(m, { width: "100%", height: "100%" })}
            {i === 3 && mediaItems.length > 4 && (
              <div style={{
                position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                background: "rgba(0,0,0,0.5)", color: "white",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 24, fontWeight: "bold"
              }}>
                +{mediaItems.length - 4}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="ios-glass" style={{
      maxWidth: 360,
      width: "100%",
      border: "1px solid rgba(255,255,255,0.2)",
      borderRadius: 16,
      overflow: "hidden",
      fontFamily: "system-ui, -apple-system, sans-serif",
      boxShadow: "0 8px 32px rgba(0,0,0,0.1)",
      margin: "0 auto"
    }}>
      <div style={{
        background: "rgba(255,255,255,0.1)",
        padding: "10px 16px",
        fontWeight: 600,
        fontSize: 14,
        borderBottom: "1px solid rgba(255,255,255,0.1)"
      }}>
        {label || "Preview"}
      </div>

      {langTabs && (
        <div style={{ display: "flex", padding: "8px 16px", gap: 8, background: "rgba(0,0,0,0.1)" }}>
          {langTabs.map((l) => (
            <button
              key={l}
              onClick={() => setTab(l)}
              style={{
                flex: 1,
                padding: "6px",
                border: "none",
                borderRadius: 8,
                background: tab === l ? "#007aff" : "rgba(255,255,255,0.1)",
                color: tab === l ? "#fff" : "var(--text-color)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.2s"
              }}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {mediaItems && mediaItems.length > 0 && mediaPosition === "above" && renderMedia()}

      <div style={{ padding: 16 }}>
        <div
          className="telegram-html-preview"
          style={{ whiteSpace: "pre-wrap", fontSize: 15, lineHeight: 1.4, wordBreak: "break-word" }}
          dangerouslySetInnerHTML={{ __html: window.sanitizeTelegramHtmlForPreview ? window.sanitizeTelegramHtmlForPreview(content) : content }}
        />
      </div>

      {mediaItems && mediaItems.length > 0 && mediaPosition === "below" && renderMedia()}

      {buttons && buttons.length > 0 && (
        <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          {buttons.map((btn, i) => (
            <div key={i} style={{
              background: "rgba(255,255,255,0.1)",
              padding: "12px",
              textAlign: "center",
              borderRadius: 10,
              fontSize: 15,
              color: "#007aff",
              fontWeight: 500,
              cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.05)"
            }}>
              {btn}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export const MediaUploader = React.memo(function MediaUploader({ onAdd, onRemove, items }) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    if (items.length + files.length > 10) {
      alert("Maximum 10 media items allowed per message.");
      return;
    }

    setUploading(true);
    try {
      const results = [];
      for (const file of files) {
        const type = file.type.startsWith("video/") ? "video" : "photo";
        if (type === "video" && file.size > 50 * 1024 * 1024) {
          throw new Error(`Video ${file.name} exceeds 50MB limit for bots.`);
        }
        const data = await api.uploadMedia(file, type);
        results.push({ file_id: data.file_id, type: data.type, url: data.url });
      }
      onAdd(results);
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {items.map((m, idx) => (
          <div key={idx} style={{
            position: "relative",
            width: 80,
            height: 80,
            borderRadius: 8,
            overflow: "hidden",
            background: "rgba(255,255,255,0.1)",
            border: "1px solid rgba(255,255,255,0.2)"
          }}>
            {m.type === "photo" ? (
              <img src={m.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" />
            ) : (
              <video src={m.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            )}
            <div
              style={{
                position: "absolute",
                top: 4,
                right: 4,
                background: "rgba(0,0,0,0.6)",
                color: "white",
                borderRadius: "50%",
                width: 20,
                height: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                cursor: "pointer",
                fontWeight: "bold"
              }}
              onClick={() => onRemove(idx)}
              title="Remove"
            >
              ×
            </div>
            {m.type === "video" && (
              <div style={{
                position: "absolute",
                bottom: 4,
                left: 4,
                background: "rgba(0,0,0,0.6)",
                color: "white",
                borderRadius: 4,
                padding: "2px 4px",
                fontSize: 10,
              }}>
                📹
              </div>
            )}
          </div>
        ))}
        {items.length < 10 && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: 80, height: 80, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 4, padding: 0 }}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <span style={{ fontSize: 24 }}>{uploading ? "⏳" : "+"}</span>
            <span style={{ fontSize: 10 }}>{items.length}/10</span>
          </button>
        )}
      </div>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleUpload}
        accept="image/jpeg,image/png,image/gif,video/mp4"
        style={{ display: "none" }}
        multiple
      />
    </div>
  );
});

export function MediaPositionSelector({ name, position, onChange }) {
  return (
    <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 14 }}>
        <input
          type="radio"
          name={name}
          value="above"
          checked={position === "above"}
          onChange={() => onChange("above")}
        />
        Above text
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 14 }}>
        <input
          type="radio"
          name={name}
          value="below"
          checked={position === "below"}
          onChange={() => onChange("below")}
        />
        Below text
      </label>
    </div>
  );
}

export function useFormattingToolbar(textareaRef, value, onChange) {
  const insertTag = (tagOpen, tagClose) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selectedText = value.substring(start, end);
    const before = value.substring(0, start);
    const after = value.substring(end);
    onChange(before + tagOpen + selectedText + tagClose + after);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + tagOpen.length, end + tagOpen.length);
    }, 0);
  };

  const insertLink = () => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selectedText = value.substring(start, end);
    const url = window.prompt("Enter URL:", "https://");
    if (!url) return;
    const tagOpen = `<a href="${url}">`;
    const tagClose = `</a>`;
    const before = value.substring(0, start);
    const after = value.substring(end);
    onChange(before + tagOpen + (selectedText || "link text") + tagClose + after);
    setTimeout(() => {
      el.focus();
      const newStart = start + tagOpen.length;
      const newEnd = newStart + (selectedText ? selectedText.length : 9);
      el.setSelectionRange(newStart, newEnd);
    }, 0);
  };

  const handleKeyDown = (e) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key === "b") { e.preventDefault(); insertTag("<b>", "</b>"); }
      if (e.key === "i") { e.preventDefault(); insertTag("<i>", "</i>"); }
      if (e.key === "u") { e.preventDefault(); insertTag("<u>", "</u>"); }
      if (e.key === "k") { e.preventDefault(); insertLink(); }
    }
  };

  const toolbar = (
    <div className="formatting-toolbar">
      <button type="button" onClick={() => insertTag("<b>", "</b>")} title="Bold (Ctrl+B)"><b>B</b></button>
      <button type="button" onClick={() => insertTag("<i>", "</i>")} title="Italic (Ctrl+I)"><i>I</i></button>
      <button type="button" onClick={() => insertTag("<u>", "</u>")} title="Underline (Ctrl+U)"><u>U</u></button>
      <button type="button" onClick={() => insertTag("<s>", "</s>")} title="Strikethrough"><s>S</s></button>
      <div className="divider" />
      <button type="button" onClick={() => insertLink()} title="Link (Ctrl+K)">🔗</button>
      <button type="button" onClick={() => insertTag("<tg-spoiler>", "</tg-spoiler>")} title="Spoiler">👀</button>
    </div>
  );

  return { handleKeyDown, toolbar };
}
