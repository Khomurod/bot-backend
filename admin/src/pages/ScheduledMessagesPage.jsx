import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";
import { TelegramPreview, MediaUploader, MediaPositionSelector, useFormattingToolbar, getDaysUntilBirthday } from "../components/Shared";

export default function ScheduledMessagesPage() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [processing, setProcessing] = useState(false);

  const loadMessages = useCallback(async () => {
    try {
      const data = await api.getScheduledMessages();
      setMessages(data);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      try {
        const data = await api.getScheduledMessages();
        if (isMounted) setMessages(data);
      } catch (err) {
        if (isMounted) setStatus({ type: 'error', text: err.message });
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleCancel = async (id) => {
    if (!window.confirm('Cancel this scheduled message?')) return;
    setProcessing(true);
    try {
      await api.cancelScheduledMessage(id);
      setStatus({ type: 'success', text: 'Message cancelled.' });
      loadMessages();
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setProcessing(false);
    }
  };

  const handleSendNow = async (id) => {
    if (!window.confirm('Send this message immediately?')) return;
    setProcessing(true);
    try {
      const result = await api.sendScheduledMessageNow(id);
      setStatus({ type: 'success', text: `Message sent! ${result.sent} group(s) received, ${result.failed} failed.` });
      loadMessages();
      setTimeout(() => setStatus(null), 5000);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setProcessing(false);
    }
  };

  const statusBadge = (s) => {
    const styles = {
      pending: { bg: '#f59e0b22', color: '#f59e0b', border: '#f59e0b44', label: '⏳ Pending' },
      sent: { bg: '#16a34a22', color: '#4ade80', border: '#16a34a44', label: '✅ Sent' },
      failed: { bg: '#ef444422', color: '#ef4444', border: '#ef444444', label: '❌ Failed' },
      cancelled: { bg: '#64748b22', color: '#94a3b8', border: '#64748b44', label: '🚫 Cancelled' },
    };
    const st = styles[s] || styles.pending;
    return (
      <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>
        {st.label}
      </span>
    );
  };

  const targetLabel = (msg) => {
    if (msg.target_type === 'specific_drivers') return `🚛 ${msg.target_driver_ids?.length || 0} driver(s)`;
    if (msg.target_type === 'language_groups') return `🌐 ${(msg.target_languages || []).map(l => l.toUpperCase()).join(', ')}`;
    return '👥 All Drivers';
  };

  const langLabel = (msg) => {
    if (!msg.force_language) return '🔄 Auto';
    return { en: '🇺🇸 EN', ru: '🇷🇺 RU', uz: '🇺🇿 UZ' }[msg.force_language] || msg.force_language;
  };

  return (
    <div>
      <div className="page-header">
        <h2>📅 Scheduled Messages</h2>
        <p>View and manage scheduled broadcast messages</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`}>
          {status.type === 'success' ? '✅' : '⚠️'} {status.text}
        </div>
      )}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading scheduled messages...</div>
      ) : messages.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📅</div>
          <h3>No scheduled messages</h3>
          <p>Schedule a message from the Broadcast page to see it here.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Message</th>
                <th>Targets</th>
                <th>Language</th>
                <th>Time (Chicago)</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {messages.map(msg => (
                <tr key={msg.id}>
                  <td style={{ maxWidth: 300 }}>
                    <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {msg.message_text_en?.substring(0, 80) || '(no text)'}
                      {msg.message_text_en?.length > 80 ? '...' : ''}
                    </div>
                    {msg.media_file_id && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        📎 {msg.media_type === 'video' ? 'Video' : 'Photo'} attached
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>{targetLabel(msg)}</td>
                  <td style={{ fontSize: 12 }}>{langLabel(msg)}</td>
                  <td style={{ fontSize: 13, fontFamily: 'monospace' }}>{msg.scheduled_at_chicago}</td>
                  <td>{statusBadge(msg.status)}</td>
                  <td>
                    {msg.status === 'pending' && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => handleSendNow(msg.id)} disabled={processing} style={{ fontSize: 11, padding: '4px 10px' }}>
                          {processing ? '⏳' : '📤 Send Now'}
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleCancel(msg.id)} disabled={processing} style={{ fontSize: 11, padding: '4px 10px' }}>
                          {processing ? '⏳' : '✕ Cancel'}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Combined company report HTML for Telegram-style preview (matches server sanitization). */
