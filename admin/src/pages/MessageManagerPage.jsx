import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";
import { TelegramPreview, MediaUploader, MediaPositionSelector, useFormattingToolbar, getDaysUntilBirthday } from "../components/Shared";


export default function MessageManagerPage() {
  const [url, setUrl] = useState('');
  const [newText, setNewText] = useState('');
  const [status, setStatus] = useState(null);
  const [processing, setProcessing] = useState(false);
  const textareaRef = useRef(null);
  const { handleKeyDown, toolbar } = useFormattingToolbar(textareaRef, newText, setNewText);

  const handleDelete = async () => {
    if (!url.trim()) return setStatus({ type: 'error', text: 'Please enter a message URL.' });
    if (!window.confirm('Are you sure you want to permanently delete this message from Telegram?')) return;
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
    if (!url.trim()) return setStatus({ type: 'error', text: 'Please enter a message URL.' });
    if (!newText.trim()) return setStatus({ type: 'error', text: 'Please enter the new text.' });
    setProcessing(true);
    setStatus(null);
    try {
      await api.editTelegramMessage(url.trim(), newText);
      setStatus({ type: 'success', text: 'Message edited successfully.' });
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>🛠️ Message Manager</h2>
        <p>Edit or delete previously sent Telegram messages using their link.</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`}>
          {status.type === 'success' ? '✅' : '⚠️'} {status.text}
        </div>
      )}

      <div className="card">
        <div className="form-group">
          <label>Message Link (URL)</label>
          <input
            className="form-input"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="e.g. https://t.me/c/3833033968/5044"
          />
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            Right-click a message in Telegram and select "Copy Message Link".
          </p>
        </div>

        <div className="form-group" style={{ marginTop: 24 }}>
          <label>New Text (for editing)</label>
          {toolbar}
          <textarea
            ref={textareaRef}
            className="form-textarea toolbar-textarea"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Leave blank if you just want to delete it. Enter new text to edit..."
            style={{ minHeight: 120 }}
          />
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <button className="btn btn-primary" onClick={handleEdit} disabled={processing || !url || !newText}>
            {processing ? '⏳ Saving...' : '✏️ Edit Message'}
          </button>
          <button className="btn btn-danger" onClick={handleDelete} disabled={processing || !url}>
            {processing ? '⏳ Deleting...' : '🗑️ Delete Message'}
          </button>
        </div>
      </div>
    </div>
  );
}
