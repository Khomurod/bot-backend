import React, { useState, useRef } from "react";
import * as api from "../../api";
import { useFormattingToolbar } from "../../components/Shared";

/**
 * Edit or delete a message the bot sent, by its Telegram link — including one
 * that is not in the History log.
 *
 * A SECTION OF HISTORY SINCE NOVEMBER 2026 (`embedded`): it was its own tab,
 * "Edit by Link", beside History, and both tabs did the same job — change or
 * remove a sent message. History shows it at the top as a closed "Have a
 * message link?" section; `#communications/edit_by_link` lands there. The
 * delete still asks first.
 */
export default function EditByLinkTab({ embedded = false }) {
  const [url, setUrl] = useState('');
  const [newText, setNewText] = useState('');
  const [status, setStatus] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const textareaRef = useRef(null);
  const { handleKeyDown, toolbar } = useFormattingToolbar(textareaRef, newText, setNewText);

  const handleDelete = async () => {
    if (!url.trim()) return setStatus({ type: 'error', text: 'Please paste a message link first.' });
    setShowDeleteConfirm(false);
    setProcessing(true);
    setStatus(null);
    try {
      await api.deleteTelegramMessage(url.trim());
      setStatus({ type: 'success', text: 'Message deleted successfully.' });
      setUrl('');
      setNewText('');
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setProcessing(false);
    }
  };

  const handleEdit = async () => {
    if (!url.trim()) return setStatus({ type: 'error', text: 'Please paste a message link first.' });
    if (!newText.trim()) return setStatus({ type: 'error', text: 'Please enter the replacement text.' });
    setProcessing(true);
    setStatus(null);
    try {
      await api.editTelegramMessage(url.trim(), newText);
      setStatus({ type: 'success', text: 'Message updated successfully.' });
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setProcessing(false);
    }
  };

  const Wrapper = embedded ? "details" : "div";
  return (
    <Wrapper className={embedded ? "card" : undefined} style={embedded ? { marginBottom: 16 } : undefined}>
      {embedded ? (
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          Have a message link?{" "}
          <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>Edit or delete a message the bot sent — even one not in the list below.</span>
        </summary>
      ) : (
        <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 20 }}>Edit or delete a message the bot previously sent in Telegram.</p>
      )}

      {status && (
        <div className={`alert alert-${status.type}`}>
          {status.type === 'success' ? '✅' : '⚠️'} {status.text}
        </div>
      )}

      <div className={embedded ? undefined : "card"} style={embedded ? { marginTop: 12 } : undefined}>
        <div className="form-group">
          <label>Message Link</label>
          <input
            className="form-input"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a Telegram message link here…"
          />
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            💡 Right-click any message in Telegram → "Copy Message Link" → paste it above.
          </p>
        </div>

        <div className="form-group" style={{ marginTop: 24 }}>
          <label>Replacement Text</label>
          {toolbar}
          <textarea
            ref={textareaRef}
            className="form-textarea toolbar-textarea"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type the new message text…"
            style={{ minHeight: 120 }}
          />
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <button className="btn btn-primary" onClick={handleEdit} disabled={processing || !url || !newText}>
            {processing ? '⏳ Saving…' : '✏️ Update Message'}
          </button>
          <button
            className="btn btn-danger"
            onClick={() => url.trim() ? setShowDeleteConfirm(true) : setStatus({ type: 'error', text: 'Please paste a message link first.' })}
            disabled={processing || !url}
          >
            🗑️ Delete Message
          </button>
        </div>
      </div>

      {showDeleteConfirm && (
        <div className="confirm-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete this message?</h3>
            <p>This will permanently remove the message from Telegram. This action cannot be undone.</p>
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDelete}>Yes, Delete</button>
            </div>
          </div>
        </div>
      )}
    </Wrapper>
  );
}

