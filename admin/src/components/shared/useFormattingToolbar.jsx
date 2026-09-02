/**
 * The bold / italic / link toolbar over a message textarea: wraps the current
 * selection in Telegram's HTML tags and restores the caret afterwards.
 *
 * Kept as a hook rather than a component so each page can render its own
 * toolbar chrome around the same selection behavior.
 *
 * Split out of admin/src/components/Shared.jsx.
 */

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
      <button type="button" className="fmt-btn" onClick={() => insertTag("<b>", "</b>")} title="Bold (Ctrl+B)"><b>B</b></button>
      <button type="button" className="fmt-btn" onClick={() => insertTag("<i>", "</i>")} title="Italic (Ctrl+I)"><i>I</i></button>
      <button type="button" className="fmt-btn" onClick={() => insertTag("<u>", "</u>")} title="Underline (Ctrl+U)"><u>U</u></button>
      <button type="button" className="fmt-btn" onClick={() => insertTag("<s>", "</s>")} title="Strikethrough"><s>S</s></button>
      <div className="fmt-sep" />
      <button type="button" className="fmt-btn" onClick={() => insertLink()} title="Link (Ctrl+K)">Link</button>
      <button type="button" className="fmt-btn" onClick={() => insertTag("<tg-spoiler>", "</tg-spoiler>")} title="Spoiler">Spoiler</button>
    </div>
  );

  return { handleKeyDown, toolbar };
}
