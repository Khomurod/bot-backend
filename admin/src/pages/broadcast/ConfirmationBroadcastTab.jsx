import React from "react";
import { TelegramPreview, MediaUploader, MediaPositionSelector } from "../../components/Shared";
import { PlaceholderChips } from "./PlaceholderChips";
import { formatDate, truncate } from "./composerHelpers";

/**
 * The confirmation composer: message, the inline keyboard, its preview, and the
 * history with per-broadcast click counts.
 *
 * The click summary is the reason this tab exists — a confirmation is asked in
 * order to be answered, so the history shows which button each driver tapped
 * rather than only whether delivery succeeded.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export function ConfirmationBroadcastTab({
  confirmation, targeting, history, setShowSendConfirm, insertTokenIntoEditor,
}) {
  // Aliased to the names the markup below already uses, so the JSX moved out of
  // BroadcastPage.jsx is unchanged.
  const {
    message: confMessage, setMessage: setConfMessage,
    messageRu: confMessageRu, setMessageRu: setConfMessageRu,
    messageUz: confMessageUz, setMessageUz: setConfMessageUz,
    mediaItems: confMediaItems, setMediaItems: setConfMediaItems,
    mediaPosition: confMediaPosition, setMediaPosition: setConfMediaPosition,
    buttons: confirmationButtons, addButton: addConfButton,
    removeButton: removeConfButton, updateButton: updateConfButton,
    sending: confSending, testing: confTesting, translating: confTranslating,
    btnTranslating: confBtnTranslating, status: confStatus,
    setActiveField: setActiveConfirmationField,
    enRef: confTextareaRef, ruRef: confRuRef, uzRef: confUzRef,
    fmt: confFmt, fmtRu: confFmtRu, fmtUz: confFmtUz,
    unknownTokens: confirmationUnknownTokens,
    handleAutoTranslate: handleConfAutoTranslate,
    handleAutoTranslateButtons: handleConfAutoTranslateButtons,
    handleTest: handleConfTest,
  } = confirmation;
  const { broadcastPlaceholders } = targeting;
  const {
    history: confHistory, historyLoading: confHistoryLoading,
    loadHistory: loadConfHistory, expandedId: expandedConfBroadcast,
    deliveries: confDeliveries, toggleDeliveries: toggleConfDeliveries,
    expandedClicks, clicks: confClicks, toggleClicks: toggleConfClicks,
    getClickSummary,
  } = history;

  return (

  <div>
    {confStatus && <div className={`alert alert-${confStatus.type}`}>{confStatus.type === 'success' ? '✅' : '⚠️'} {confStatus.text}</div>}

    <div className="broadcast-layout">
      <div className="broadcast-editor-section">
        <div className="card">
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>✍️ Compose Message</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Use the toolbar to format text with Telegram-compatible HTML tags.</p>
          <PlaceholderChips
            placeholders={broadcastPlaceholders}
            onInsert={(token) => insertTokenIntoEditor('confirmation', token)}
          />
          {confirmationUnknownTokens.length > 0 && (
            <div className="alert alert-error" style={{ marginBottom: 12 }}>
              Unknown placeholders: {confirmationUnknownTokens.map((t) => `{${t}}`).join(', ')}
            </div>
          )}

          <h4 style={{ marginBottom: 6 }}><span className="badge badge-en">EN</span> English</h4>
          {confFmt.toolbar}
          <textarea ref={confTextareaRef} className="form-textarea toolbar-textarea" value={confMessage} onChange={(e) => setConfMessage(e.target.value)} onKeyDown={confFmt.handleKeyDown}
            onFocus={() => setActiveConfirmationField('en')}
            placeholder="Type your confirmation message here..." style={{ minHeight: 140, resize: 'vertical' }} />
          <div className={`char-count ${confMessage.length > 4096 ? 'over-limit' : ''}`}>{confMessage.length} / 4096</div>

          <button type="button" className="btn btn-ghost" onClick={handleConfAutoTranslate} disabled={confTranslating || !confMessage.trim()}
            style={{ marginTop: 12, marginBottom: 16, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {confTranslating ? '⏳ Translating...' : '🌐 Auto Translate'}
          </button>

          <details className="collapse-panel">
            <summary>🌐 Russian &amp; Uzbek translations</summary>
            <div style={{ marginTop: 12 }}>
              <h4 style={{ marginBottom: 6 }}><span className="badge badge-ru">RU</span> Russian</h4>
              {confFmtRu.toolbar}
              <textarea ref={confRuRef} className="form-textarea toolbar-textarea" value={confMessageRu} onChange={(e) => setConfMessageRu(e.target.value)} onKeyDown={confFmtRu.handleKeyDown}
                onFocus={() => setActiveConfirmationField('ru')}
                placeholder="Сообщение на русском (авто-перевод или ручной ввод)" style={{ minHeight: 100, resize: 'vertical', marginBottom: 12 }} />

              <h4 style={{ marginBottom: 6 }}><span className="badge badge-uz">UZ</span> Uzbek</h4>
              {confFmtUz.toolbar}
              <textarea ref={confUzRef} className="form-textarea toolbar-textarea" value={confMessageUz} onChange={(e) => setConfMessageUz(e.target.value)} onKeyDown={confFmtUz.handleKeyDown}
                onFocus={() => setActiveConfirmationField('uz')}
                placeholder="O'zbek tilidagi xabar (avto-tarjima yoki qo'lda kiritish)" style={{ minHeight: 100, resize: 'vertical' }} />
            </div>
          </details>

          <div style={{ marginTop: 16 }}>
            <MediaUploader items={confMediaItems} onAdd={(newItems) => setConfMediaItems(prev => [...prev, ...newItems])} onRemove={(index) => setConfMediaItems(prev => prev.filter((_, i) => i !== index))} />
            {confMediaItems.length > 0 && <div style={{ marginTop: 16 }}><MediaPositionSelector name="conf-media-position" position={confMediaPosition} onChange={setConfMediaPosition} /></div>}
          </div>

          {/* ─── Inline Buttons Builder ─── */}
          <div className="card button-builder" style={{ marginTop: 20, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600 }}>🔘 Inline Buttons</h3>
              <button type="button" className="btn btn-ghost" onClick={handleConfAutoTranslateButtons} disabled={confBtnTranslating} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>
                {confBtnTranslating ? '⏳' : '🌐'} Auto-translate Labels
              </button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Add buttons drivers can click. At least 1 button required to send.</p>
            {confirmationButtons.map((btn, i) => (
              <div key={i} className="button-builder-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', minWidth: 60 }}>Button {i + 1}</span>
                  {confirmationButtons.length > 1 && <button type="button" className="btn btn-danger btn-sm" onClick={() => removeConfButton(i)} style={{ marginLeft: 'auto' }}>✕</button>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 120 }}>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>🇺🇸 EN</label>
                    <input className="form-input" style={{ width: '100%', fontSize: 13 }} value={btn.label_en} onChange={(e) => updateConfButton(i, 'label_en', e.target.value)} placeholder="Yes / Confirm" />
                  </div>
                  <div style={{ flex: 1, minWidth: 120 }}>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>🇷🇺 RU</label>
                    <input className="form-input" style={{ width: '100%', fontSize: 13 }} value={btn.label_ru} onChange={(e) => updateConfButton(i, 'label_ru', e.target.value)} placeholder="Да / Подтвердить" />
                  </div>
                  <div style={{ flex: 1, minWidth: 120 }}>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>🇺🇿 UZ</label>
                    <input className="form-input" style={{ width: '100%', fontSize: 13 }} value={btn.label_uz} onChange={(e) => updateConfButton(i, 'label_uz', e.target.value)} placeholder="Ha / Tasdiqlash" />
                  </div>
                </div>
              </div>
            ))}
            <button type="button" className="btn btn-ghost" onClick={addConfButton} style={{ marginTop: 8, fontSize: 13, border: '1px dashed var(--border)' }}>
              ➕ Add Button
            </button>
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => setShowSendConfirm('confirmation')} disabled={confSending || !confMessage.trim() || confMessage.length > 4096 || confirmationUnknownTokens.length > 0}>
              {confSending ? '⏳ Sending...' : '📤 Send Broadcast'}
            </button>
            <button className="btn btn-ghost" onClick={handleConfTest} disabled={confTesting || !confMessage.trim() || confirmationUnknownTokens.length > 0} style={{ border: '1px solid var(--border)' }}>
              {confTesting ? '⏳ Testing...' : '🧪 Test'}
            </button>
          </div>
        </div>
      </div>

      <div className="broadcast-preview-section">
        <div className="card">
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>📱 Live Preview</h3>
          <TelegramPreview label="How it will look in Telegram" text={confMessage}
            langTabs={{
              en: { text: confMessage, buttons: confirmationButtons.map(b => b.label_en).filter(Boolean) },
              ru: { text: confMessageRu, buttons: confirmationButtons.map(b => b.label_ru || b.label_en).filter(Boolean) },
              uz: { text: confMessageUz, buttons: confirmationButtons.map(b => b.label_uz || b.label_en).filter(Boolean) },
            }}
            mediaItems={confMediaItems} mediaPosition={confMediaPosition} />
        </div>
      </div>
    </div>

    {/* ─── Confirmation Broadcast History ─── */}
    <div className="card broadcast-history" style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>📋 Broadcast History</h3>
        <button type="button" className="btn btn-ghost" onClick={loadConfHistory} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>🔄 Refresh</button>
      </div>
      {confHistoryLoading ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading...</div>
        : confHistory.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No confirmation broadcasts sent yet.</div>
        : confHistory.map(b => (
          <div key={b.id} className="broadcast-history-item">
            <div className="broadcast-history-header" style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }} onClick={() => toggleConfDeliveries(b.id)}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{formatDate(b.created_at)}</span>
                <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-muted)' }}>{truncate(b.message_text_en, 60)}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>✅ {b.sent_count || 0}</span>
                {Number(b.failed_count) > 0 && <span className="badge" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>❌ {b.failed_count}</span>}
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expandedConfBroadcast === b.id ? '▲' : '▼'}</span>
              </div>
            </div>
            {expandedConfBroadcast === b.id && (
              <div>
                <div className="delivery-list">
                  {(confDeliveries[b.id] || []).length === 0
                    ? <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8 }}>No delivery data.</div>
                    : (confDeliveries[b.id] || []).map(d => (
                      <div key={d.id} className="delivery-row">
                        <span style={{ fontSize: 13 }}>{d.group_name || `Group ${d.telegram_group_id}`}</span>
                        <span className={`status-pill status-pill--${d.status === 'sent' ? 'success' : 'danger'}`}>{d.status === 'sent' ? 'Delivered' : 'Failed'}</span>
                      </div>
                    ))}
                </div>
                <div style={{ marginTop: 12 }}>
                  <button type="button" className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); toggleConfClicks(b.id); }} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>
                    {expandedClicks === b.id ? '▲ Hide' : '📊 Show'} Click Tracking
                  </button>
                  {expandedClicks === b.id && (
                    <div className="click-tracking-table" style={{ marginTop: 10 }}>
                      {(confClicks[b.id] || []).length === 0
                        ? <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8 }}>No clicks recorded yet.</div>
                        : (
                          <>
                            <div style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              {getClickSummary(confClicks[b.id]).map(([k, v]) => (
                                <span key={k} className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent-hover)' }}>{k}: {v} click{v !== 1 ? 's' : ''}</span>
                              ))}
                            </div>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                              <thead>
                                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Driver</th>
                                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Group</th>
                                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Button</th>
                                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Time</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(confClicks[b.id] || []).map(c => (
                                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                    <td style={{ padding: '6px 8px' }}>{c.driver_username ? `@${c.driver_username}` : `${c.driver_first_name || ''} ${c.driver_last_name || ''}`.trim() || c.driver_telegram_id}</td>
                                    <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{c.group_name || '-'}</td>
                                    <td style={{ padding: '6px 8px' }}><span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent-hover)' }}>Button {c.button_index + 1}</span></td>
                                    <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{formatDate(c.clicked_at)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </>
                        )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
    </div>
  </div>
  );
}
