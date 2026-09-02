import React, { useState, useEffect, useMemo } from "react";

/**
 * A faithful mock-up of how a message will look in Telegram: the bubble, the
 * inline keyboard, the media position, and one tab per language when a
 * broadcast is translated.
 *
 * It exists so an admin can check formatting BEFORE sending to hundreds of
 * driver groups, where a mistake cannot be recalled. Presentation only — it
 * sends nothing and reads no API.
 *
 * Split out of admin/src/components/Shared.jsx.
 */

export const TelegramPreview = React.memo(function TelegramPreview({ text, buttons, label, langTabs, mediaItems, mediaPosition }) {
  const [tab, setTab] = useState(null);
  const [mounted, setMounted] = useState(false);

  const previewModel = useMemo(() => {
    const tabData = {};
    let tabOrder = [];

    if (Array.isArray(langTabs) && langTabs.length > 0) {
      tabOrder = langTabs.filter((lang) => typeof lang === "string" && lang.trim());
      tabOrder.forEach((lang) => {
        const textValue = text && typeof text === "object"
          ? (text[lang] || "")
          : (text || "");
        const buttonValue = Array.isArray(buttons)
          ? buttons
          : (buttons && typeof buttons === "object" && Array.isArray(buttons[lang]) ? buttons[lang] : []);
        tabData[lang] = { text: textValue, buttons: buttonValue };
      });
      return { tabOrder, tabData };
    }

    if (langTabs && typeof langTabs === "object") {
      tabOrder = Object.keys(langTabs);
      tabOrder.forEach((lang) => {
        const cfg = langTabs[lang];
        const fallbackText = text && typeof text === "object"
          ? (text[lang] || "")
          : (text || "");
        const cfgText = cfg && typeof cfg === "object" && !Array.isArray(cfg)
          ? cfg.text
          : cfg;
        const cfgButtons = cfg && typeof cfg === "object" && Array.isArray(cfg.buttons)
          ? cfg.buttons
          : null;
        const buttonValue = cfgButtons
          || (Array.isArray(buttons)
            ? buttons
            : (buttons && typeof buttons === "object" && Array.isArray(buttons[lang]) ? buttons[lang] : []));
        tabData[lang] = {
          text: cfgText != null ? cfgText : fallbackText,
          buttons: buttonValue || [],
        };
      });
      return { tabOrder, tabData };
    }

    if (text && typeof text === "object" && !Array.isArray(text)) {
      tabOrder = Object.keys(text);
      tabOrder.forEach((lang) => {
        const buttonValue = Array.isArray(buttons)
          ? buttons
          : (buttons && typeof buttons === "object" && Array.isArray(buttons[lang]) ? buttons[lang] : []);
        tabData[lang] = { text: text[lang] || "", buttons: buttonValue };
      });
      return { tabOrder, tabData };
    }

    return { tabOrder, tabData };
  }, [langTabs, text, buttons]);

  const normalizedMediaItems = useMemo(() => {
    if (!Array.isArray(mediaItems)) return [];
    return mediaItems.reduce((acc, item) => {
      if (Array.isArray(item)) {
        item.forEach((nested) => {
          if (nested && typeof nested === "object") acc.push(nested);
        });
      } else if (item && typeof item === "object") {
        acc.push(item);
      }
      return acc;
    }, []);
  }, [mediaItems]);

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    const langs = previewModel.tabOrder;
    if (!langs.length) {
      if (tab !== null) setTab(null);
      return;
    }
    if (!tab || !langs.includes(tab)) setTab(langs[0]);
  }, [previewModel.tabOrder, tab]);

  if (!mounted) return null;

  const activeTab = previewModel.tabOrder.length ? (tab || previewModel.tabOrder[0]) : null;
  const content = activeTab
    ? (previewModel.tabData[activeTab]?.text || "")
    : (text && typeof text === "object" ? "" : (text || ""));
  const visibleButtons = activeTab
    ? (previewModel.tabData[activeTab]?.buttons || [])
    : (Array.isArray(buttons) ? buttons : []);

  const getMediaElement = (item, style) => {
    const type = item.type || item.media_type;
    const src = item.url || item.preview_url || null;

    if (type === "photo") {
      if (!src) return <div style={{ ...style, display: "grid", placeItems: "center", color: "#666", fontSize: 12 }}>photo</div>;
      return <img src={src} alt="attachment" style={{ ...style, objectFit: "cover" }} />;
    }
    if (type === "video") {
      if (!src) return <div style={{ ...style, display: "grid", placeItems: "center", color: "#666", fontSize: 12 }}>video</div>;
      return (
        <video style={{ ...style, objectFit: "cover", background: "#000" }} controls preload="metadata">
          <source src={src} type="video/mp4" />
        </video>
      );
    }
    return null;
  };

  const renderMedia = () => {
    if (!normalizedMediaItems.length) return null;

    if (normalizedMediaItems.length === 1) {
      return (
        <div style={{ width: "100%", maxHeight: 300, overflow: "hidden", display: "flex", justifyContent: "center", background: "#f0f0f0" }}>
          {getMediaElement(normalizedMediaItems[0], { maxWidth: "100%", maxHeight: 300 })}
        </div>
      );
    }

    const gridStyle = {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 2,
      maxHeight: 400,
      overflow: "hidden",
    };

    return (
      <div style={gridStyle}>
        {normalizedMediaItems.slice(0, 4).map((m, i) => (
          <div key={i} style={{ position: "relative", width: "100%", aspectRatio: "1" }}>
            {getMediaElement(m, { width: "100%", height: "100%" })}
            {i === 3 && normalizedMediaItems.length > 4 && (
              <div style={{
                position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                background: "rgba(0,0,0,0.5)", color: "white",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 24, fontWeight: "bold",
              }}>
                +{normalizedMediaItems.length - 4}
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
      margin: "0 auto",
    }}>
      <div style={{
        background: "rgba(255,255,255,0.1)",
        padding: "10px 16px",
        fontWeight: 600,
        fontSize: 14,
        borderBottom: "1px solid rgba(255,255,255,0.1)",
      }}>
        {label || "Preview"}
      </div>

      {previewModel.tabOrder.length > 0 && (
        <div style={{ display: "flex", padding: "8px 16px", gap: 8, background: "rgba(0,0,0,0.1)" }}>
          {previewModel.tabOrder.map((l) => (
            <button
              key={l}
              onClick={() => setTab(l)}
              style={{
                flex: 1,
                padding: "6px",
                border: "none",
                borderRadius: 8,
                background: activeTab === l ? "#007aff" : "rgba(255,255,255,0.1)",
                color: activeTab === l ? "#fff" : "var(--text-color)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.2s",
              }}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {normalizedMediaItems.length > 0 && mediaPosition === "above" && renderMedia()}

      <div style={{ padding: 16 }}>
        <div
          className="telegram-html-preview"
          style={{ whiteSpace: "pre-wrap", fontSize: 15, lineHeight: 1.4, wordBreak: "break-word" }}
          dangerouslySetInnerHTML={{ __html: window.sanitizeTelegramHtmlForPreview ? window.sanitizeTelegramHtmlForPreview(content) : content }}
        />
      </div>

      {normalizedMediaItems.length > 0 && mediaPosition === "below" && renderMedia()}

      {visibleButtons.length > 0 && (
        <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          {visibleButtons.map((btn, i) => (
            <div key={i} style={{
              background: "rgba(255,255,255,0.1)",
              padding: "12px",
              textAlign: "center",
              borderRadius: 10,
              fontSize: 15,
              color: "#007aff",
              fontWeight: 500,
              cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.05)",
            }}>
              {btn}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
