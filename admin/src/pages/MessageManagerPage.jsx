import React, { useState, useRef } from "react";
import * as api from "../api";
import { useFormattingToolbar } from "../components/Shared";

export default function MessageManagerPage() {
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

  return (
    <div>
      <div className="page-header">
        <h2>🛠️ Edit Message</h2>
        <p>Edit or delete a message the bot previously sent in Telegram.</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`}>
          {status.type === 'success' ? '✅' : '⚠️'} {status.text}
        </div>
      )}

      <div className="card">
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
            <h3>🗑️ Delete this message?</h3>
            <p>This will permanently remove the message from Telegram. This action cannot be undone.</p>
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDelete}>Yes, Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

