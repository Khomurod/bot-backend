import React from "react";
import { TelegramPreview, MediaUploader, MediaPositionSelector } from "../../components/Shared";
import { PlaceholderChips } from "./PlaceholderChips";
import { WEEKLY_DAY_OPTIONS, formatDate, truncate } from "./composerHelpers";

/**
 * The announcement composer, its live Telegram preview, the schedule controls,
 * and the sent-broadcast history.
 *
 * Send goes through the page's confirmation dialog rather than firing directly:
 * a broadcast reaches every targeted driver group at once and cannot be
 * recalled. Test, which only reaches the management group, has no such prompt.
 *
 * The unknown-token warning renders next to the editor so it is visible before
 * an admin reaches the send button, not only after pressing it.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export function RegularBroadcastTab({
  regular, targeting, history, setShowSendConfirm, insertTokenIntoEditor,
}) {
  // Aliased to the names the markup below already uses, so the JSX moved out of
  // BroadcastPage.jsx is unchanged.
  const {
    message, setMessage, messageRu, setMessageRu, messageUz, setMessageUz,
    mediaItems: broadcastMediaItems, setMediaItems: setBroadcastMediaItems,
    mediaPosition: broadcastMediaPosition, setMediaPosition: setBroadcastMediaPosition,
    sending, testing, translating, scheduling, status,
    scheduleType, setScheduleType, scheduledAtChicago, setScheduledAtChicago,
    weeklyDayOfWeek, setWeeklyDayOfWeek, weeklyTimeChicago, setWeeklyTimeChicago,
    setActiveField: setActiveRegularField,
    enRef: regTextareaRef, ruRef: regRuRef, uzRef: regUzRef,
    fmt: regFmt, fmtRu: regFmtRu, fmtUz: regFmtUz,
    unknownTokens: regularUnknownTokens,
    handleAutoTranslate, handleTest, handleSchedule,
  } = regular;
  const { broadcastPlaceholders, targetType } = targeting;
  const {
    history: regularHistory, historyLoading: regularHistoryLoading,
    loadHistory: loadRegularHistory, expandedId: expandedRegularBroadcast,
    deliveries: regularDeliveries, toggleDeliveries: toggleRegularDeliveries,
  } = history;
  const weeklyDayOptions = WEEKLY_DAY_OPTIONS;

  return (

  <div>
    {status && <div className={`alert alert-${status.type}`}>{status.type === 'success' ? '✅' : '⚠️'} {status.text}</div>}

    <div className="broadcast-layout">
      <div className="broadcast-editor-section">
        <div className="card">
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>✍️ Compose Message</h3>

          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Use the toolbar to format text with Telegram-compatible HTML tags.</p>
          <PlaceholderChips
            placeholders={broadcastPlaceholders}
            onInsert={(token) => insertTokenIntoEditor('regular', token)}
          />
          {regularUnknownTokens.length > 0 && (
            <div className="alert alert-error" style={{ marginBottom: 12 }}>
              Unknown placeholders: {regularUnknownTokens.map((t) => `{${t}}`).join(', ')}
            </div>
          )}

          <h4 style={{ marginBottom: 6 }}><span className="badge badge-en">EN</span> English</h4>
          {regFmt.toolbar}
          <textarea ref={regTextareaRef} className="form-textarea toolbar-textarea" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={regFmt.handleKeyDown}
            onFocus={() => setActiveRegularField('en')}
            placeholder="Type your message here..." style={{ minHeight: 140, resize: 'vertical' }} />
          <div className={`char-count ${message.length > 4096 ? 'over-limit' : ''}`}>{message.length} / 4096</div>

          <button type="button" className="btn btn-ghost" onClick={handleAutoTranslate} disabled={translating || !message.trim()}
            style={{ marginTop: 12, marginBottom: 16, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {translating ? '⏳ Translating...' : '🌐 Auto Translate'}
          </button>

          <details className="collapse-panel">
            <summary>🌐 Russian &amp; Uzbek translations</summary>
            <div style={{ marginTop: 12 }}>
              <h4 style={{ marginBottom: 6 }}><span className="badge badge-ru">RU</span> Russian</h4>
              {regFmtRu.toolbar}
              <textarea ref={regRuRef} className="form-textarea toolbar-textarea" value={messageRu} onChange={(e) => setMessageRu(e.target.value)} onKeyDown={regFmtRu.handleKeyDown}
                onFocus={() => setActiveRegularField('ru')}
                placeholder="Сообщение на русском (авто-перевод или ручной ввод)" style={{ minHeight: 100, resize: 'vertical', marginBottom: 12 }} />

              <h4 style={{ marginBottom: 6 }}><span className="badge badge-uz">UZ</span> Uzbek</h4>
              {regFmtUz.toolbar}
              <textarea ref={regUzRef} className="form-textarea toolbar-textarea" value={messageUz} onChange={(e) => setMessageUz(e.target.value)} onKeyDown={regFmtUz.handleKeyDown}
                onFocus={() => setActiveRegularField('uz')}
                placeholder="O'zbek tilidagi xabar (avto-tarjima yoki qo'lda kiritish)" style={{ minHeight: 100, resize: 'vertical' }} />
            </div>
          </details>

          <details className="collapse-panel" style={{ marginTop: 16 }}>
            <summary>📎 Media Attachments</summary>
            <div style={{ marginTop: 12 }}>
              <MediaUploader items={broadcastMediaItems} onAdd={(newItems) => setBroadcastMediaItems(prev => [...prev, ...newItems])} onRemove={(index) => setBroadcastMediaItems(prev => prev.filter((_, i) => i !== index))} />
              {broadcastMediaItems.length > 0 && <div style={{ marginTop: 16 }}><MediaPositionSelector name="broadcast-media-position" position={broadcastMediaPosition} onChange={setBroadcastMediaPosition} /></div>}
            </div>
          </details>

          <div className="card" style={{ marginTop: 20, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>⏰ Schedule for Later</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                  Schedule this message to be sent at a specific time (Central Time).
                </p>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="radio" name="regular-schedule-type" checked={scheduleType === 'one_time'} onChange={() => setScheduleType('one_time')} />
                  One time
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="radio" name="regular-schedule-type" checked={scheduleType === 'weekly'} onChange={() => setScheduleType('weekly')} />
                  Weekly recurring
                </label>
              </div>
            </div>

            {scheduleType === 'one_time' ? (
              <div style={{ marginTop: 16 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                  Date &amp; time (Central)
                </label>
                <input
                  type="datetime-local"
                  className="form-input"
                  value={scheduledAtChicago}
                  onChange={(e) => setScheduledAtChicago(e.target.value)}
                />
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12, marginTop: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                    Day of week
                  </label>
                  <select className="form-input" value={weeklyDayOfWeek} onChange={(e) => setWeeklyDayOfWeek(e.target.value)}>
                    {weeklyDayOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                    Time (Central)
                  </label>
                  <input
                    type="time"
                    className="form-input"
                    value={weeklyTimeChicago}
                    onChange={(e) => setWeeklyTimeChicago(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => setShowSendConfirm('regular')} disabled={sending || (!message.trim() && broadcastMediaItems.length === 0) || message.length > 4096 || regularUnknownTokens.length > 0}>
              {sending ? '⏳ Sending...' : targetType === 'all' ? '📤 Send to All Groups' : '📤 Send to Selected'}
            </button>
            <button className="btn btn-ghost" onClick={handleTest} disabled={testing || (!message.trim() && broadcastMediaItems.length === 0) || regularUnknownTokens.length > 0} style={{ border: '1px solid var(--border)' }}>
              {testing ? '⏳ Testing...' : '🧪 Test (Management Group)'}
            </button>
            <button className="btn btn-ghost" onClick={handleSchedule} disabled={scheduling || (!message.trim() && broadcastMediaItems.length === 0) || message.length > 4096 || regularUnknownTokens.length > 0} style={{ border: '1px solid var(--border)' }}>
              {scheduling ? 'Scheduling...' : '⏰ Schedule'}
            </button>
          </div>
        </div>
      </div>

      <div className="broadcast-preview-section">
        <div className="card">
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>📱 Live Preview</h3>
          <TelegramPreview label="How it will look in Telegram" text={message}
            langTabs={{
              en: { text: message },
              ru: { text: messageRu || message },
              uz: { text: messageUz || message },
            }}
            mediaItems={broadcastMediaItems} mediaPosition={broadcastMediaPosition} />
        </div>
      </div>
    </div>

    {/* ─── Regular Broadcast History ─── */}
    <div className="card broadcast-history" style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>📋 Broadcast History</h3>
        <button type="button" className="btn btn-ghost" onClick={loadRegularHistory} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>🔄 Refresh</button>
      </div>
      {regularHistoryLoading ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading...</div>
        : regularHistory.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No broadcasts sent yet.</div>
        : regularHistory.map(b => (
          <div key={b.id} className="broadcast-history-item">
            <div className="broadcast-history-header" onClick={() => toggleRegularDeliveries(b.id)} style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{formatDate(b.created_at)}</span>
                <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-muted)' }}>{truncate(b.message_text_en, 60)}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>✅ {b.sent_count || 0}</span>
                {Number(b.failed_count) > 0 && <span className="badge" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>❌ {b.failed_count}</span>}
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expandedRegularBroadcast === b.id ? '▲' : '▼'}</span>
              </div>
            </div>
            {expandedRegularBroadcast === b.id && (
              <div className="delivery-list">
                {(regularDeliveries[b.id] || []).length === 0
                  ? <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8 }}>No delivery data.</div>
                  : (regularDeliveries[b.id] || []).map(d => (
                    <div key={d.id} className="delivery-row">
                      <span style={{ fontSize: 13 }}>{d.group_name || `Group ${d.telegram_group_id}`}</span>
                      <span className={`status-pill status-pill--${d.status === 'sent' ? 'success' : 'danger'}`}>{d.status === 'sent' ? 'Delivered' : 'Failed'}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        ))}
    </div>
  </div>
  );
}
