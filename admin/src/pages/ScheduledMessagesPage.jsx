import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";
import { TelegramPreview, MediaUploader, MediaPositionSelector, useFormattingToolbar, getDaysUntilBirthday } from "../components/Shared";
import { timeAgo } from "../utils/formatTime";

export default function ScheduledMessagesPage() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);

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

  const statusPillClass = (s) => {
    const map = {
      pending: 'status-pill--info',
      scheduled: 'status-pill--info',
      sent: 'status-pill--success',
      delivered: 'status-pill--success',
      failed: 'status-pill--danger',
      error: 'status-pill--danger',
      cancelled: 'status-pill--neutral',
    };
    return map[s] || 'status-pill--info';
  };

  const statusLabel = (s) => {
    const map = {
      pending: 'Pending',
      scheduled: 'Scheduled',
      sent: 'Sent',
      delivered: 'Delivered',
      failed: 'Failed',
      error: 'Error',
      cancelled: 'Cancelled',
    };
    return map[s] || s || 'Pending';
  };

  const activeFilterSuffix = (msg) => {
    if (msg.target_type !== 'all' && msg.target_type !== 'language_groups') return '';
    const f = msg.target_active_filter || 'active';
    if (f === 'all') return ' · All statuses';
    if (f === 'inactive') return ' · Inactive only';
    return ' · Active only';
  };

  const targetLabel = (msg) => {
    if (msg.target_type === 'specific_drivers') return `🚛 ${msg.target_driver_ids?.length || 0} driver(s)`;
    if (msg.target_type === 'language_groups') {
      return `🌐 ${(msg.target_languages || []).map(l => l.toUpperCase()).join(', ')}${activeFilterSuffix(msg)}`;
    }
    return `👥 All Drivers${activeFilterSuffix(msg)}`;
  };

  const langLabel = (msg) => {
    if (!msg.force_language) return '🔄 Auto';
    return { en: '🇺🇸 EN', ru: '🇷🇺 RU', uz: '🇺🇿 UZ' }[msg.force_language] || msg.force_language;
  };

  const mediaCount = (msg) => {
    if (Array.isArray(msg.media_items) && msg.media_items.length > 0) return msg.media_items.length;
    if (msg.media_count) return msg.media_count;
    return msg.media_file_id ? 1 : 0;
  };

  const mediaLabel = (msg) => {
    const count = mediaCount(msg);
    if (count <= 0) return null;
    if (count > 1) return `${count} media items attached`;
    const firstType = Array.isArray(msg.media_items) && msg.media_items[0]
      ? (msg.media_items[0].media_type || msg.media_items[0].type)
      : msg.media_type;
    return `${firstType === 'video' ? 'Video' : 'Photo'} attached`;
  };

  return (
    <div>
      <div className="page-header">
        <h2>📅 Scheduled Messages</h2>
        <p>Messages queued for future delivery.</p>
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
          <p>Schedule a message from the Broadcast page to see it here. Messages you schedule will appear in this list so you can track, send early, or cancel them.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Message</th>
                <th>Recipients</th>
                <th>Language</th>
                <th>Scheduled For</th>
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
                    {mediaCount(msg) > 0 && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        📎 {mediaLabel(msg)}
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>{targetLabel(msg)}</td>
                  <td style={{ fontSize: 12 }}>{langLabel(msg)}</td>
                  <td style={{ fontSize: 13 }}>
                    <div style={{ fontFamily: 'monospace' }}>{msg.scheduled_at_chicago}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {msg.schedule_label || 'One time'}
                    </div>
                    {msg.last_sent_at_chicago && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        Last sent: {timeAgo(msg.last_sent_at) || msg.last_sent_at_chicago}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${statusPillClass(msg.status)}`}>
                      {statusLabel(msg.status)}
                    </span>
                    {msg.last_run_status && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        Last run: {msg.last_run_status}
                      </div>
                    )}
                  </td>
                  <td>
                    {msg.status === 'pending' && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setConfirmAction({ type: 'sendNow', id: msg.id })}
                          disabled={processing}
                          style={{ fontSize: 11, padding: '4px 10px' }}
                        >
                          {processing ? '⏳' : '📤 Send Now'}
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => setConfirmAction({ type: 'cancel', id: msg.id })}
                          disabled={processing}
                          style={{ fontSize: 11, padding: '4px 10px' }}
                        >
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

      {confirmAction && (
        <div className="confirm-overlay" onClick={() => setConfirmAction(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>
              {confirmAction.type === 'sendNow' ? '📤 Send Message Now?' : '🚫 Cancel Scheduled Message?'}
            </h3>
            <p>
              {confirmAction.type === 'sendNow'
                ? 'This will send the message to all recipients immediately instead of waiting for the scheduled time.'
                : 'This will cancel the scheduled message. It will not be sent at the scheduled time.'}
            </p>
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmAction(null)}>Go Back</button>
              <button
                className={confirmAction.type === 'cancel' ? 'btn btn-danger' : 'btn btn-primary'}
                onClick={async () => {
                  const action = confirmAction;
                  setConfirmAction(null);
                  if (action.type === 'sendNow') await handleSendNow(action.id);
                  else if (action.type === 'cancel') await handleCancel(action.id);
                }}
              >
                {confirmAction.type === 'sendNow' ? 'Send Now' : 'Cancel Message'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Combined company report HTML for Telegram-style preview (matches server sanitization). */
