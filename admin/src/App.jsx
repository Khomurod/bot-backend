import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as api from './api';

// ─────────────── Telegram Message Preview ───────────────
function TelegramPreview({ text, buttons, label, langTabs, mediaItems, mediaPosition }) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [activeLang, setActiveLang] = React.useState('en');

  const displayText = langTabs && langTabs[activeLang]?.text !== undefined ? langTabs[activeLang].text : text;
  const displayButtons = langTabs && langTabs[activeLang]?.buttons !== undefined ? langTabs[activeLang].buttons : buttons;
  const effectivePosition = mediaPosition || 'above';
  const items = mediaItems || [];
  const hasMedia = items.length > 0;
  const multi = items.length > 1;

  const MediaBlock = hasMedia ? (
    <div className="tg-media-placeholder">
      {multi ? (
        // Album grid
        <div style={{ display: 'grid', gridTemplateColumns: items.length === 2 ? '1fr 1fr' : '1fr 1fr 1fr', gap: 4 }}>
          {items.map((m, i) => (
            <div key={i} style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 6, padding: 10, textAlign: 'center', fontSize: 18 }}>
              {m.previewUrl && m.type === 'photo'
                ? <img src={m.previewUrl} alt="" style={{ width: '100%', height: 60, objectFit: 'cover', borderRadius: 4 }} />
                : (m.type === 'video' ? '🎬' : '📷')
              }
            </div>
          ))}
        </div>
      ) : (
        // Single item
        items[0].previewUrl && items[0].type === 'photo' ? (
          <img src={items[0].previewUrl} alt="media preview" style={{ maxWidth: '100%', maxHeight: 180, objectFit: 'cover', borderRadius: 8 }} />
        ) : (
          <span>{items[0].type === 'video' ? '🎬 Video' : '📷 Photo'}</span>
        )
      )}
      {multi && <div style={{ fontSize: 11, color: '#8a9bb0', marginTop: 6 }}>🖼️ Album · {items.length} items</div>}
    </div>
  ) : null;

  return (
    <div style={{ padding: 16 }}>
      {label && <p style={{ fontSize: 12, color: '#64748b', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</p>}
      {langTabs && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
          {['en', 'ru', 'uz'].map(lang => (
            <button
              key={lang}
              type="button"
              onClick={() => setActiveLang(lang)}
              style={{
                padding: '4px 14px', fontSize: 12, fontWeight: 600,
                border: activeLang === lang ? '2px solid var(--primary)' : '1px solid var(--border)',
                borderRadius: 6,
                background: activeLang === lang ? 'var(--primary)' : 'transparent',
                color: activeLang === lang ? '#fff' : 'var(--text-muted)',
                cursor: 'pointer', textTransform: 'uppercase',
              }}
            >
              {{ en: '🇺🇸 EN', ru: '🇷🇺 RU', uz: '🇺🇿 UZ' }[lang]}
            </button>
          ))}
        </div>
      )}
      <div className="telegram-preview">
        {MediaBlock && effectivePosition === 'above' && MediaBlock}
        <div className="tg-text" dangerouslySetInnerHTML={{ __html: (displayText || '<span style="color:#6b7d8e">Type a message to see preview...</span>').replace(/\n/g, '<br/>') }} />
        {displayButtons && displayButtons.length > 0 && (
          <div className="tg-buttons">
            {displayButtons.map((btn, i) => (
              <div className="tg-btn" key={i}>{btn}</div>
            ))}
          </div>
        )}
        {MediaBlock && effectivePosition === 'below' && MediaBlock}
        <div className="tg-time">{timeStr}</div>
      </div>
    </div>
  );
}

// ─────────────── Media Uploader (multi-file) ───────────────
// onAdd(item): item = { file_id, type, previewUrl }  — called when a file is uploaded
// onRemove(index): remove item at index
// items: [{ file_id, type, previewUrl }]
function MediaUploader({ onAdd, onRemove, items }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const fileInputRef = useRef(null);
  const MAX_ITEMS = 10;
  const ACCEPTED = '.jpg,.jpeg,.png,.webp,.mp4,.mov';
  const MAX_MB = 20;

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!fileInputRef.current) return;
    fileInputRef.current.value = '';
    if (!file) return;

    if (file.size > MAX_MB * 1024 * 1024) {
      setUploadError(`File too large. Maximum size is ${MAX_MB}MB.`);
      return;
    }

    setUploadError(null);
    setUploading(true);
    try {
      const result = await api.uploadMedia(file);
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      onAdd({ file_id: result.file_id, type: result.media_type, previewUrl });
    } catch (err) {
      setUploadError(err.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const canAddMore = !uploading && (!items || items.length < MAX_ITEMS);

  return (
    <div className="media-upload-section">
      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
        📎 Media Attachments{' '}
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>(optional · up to {MAX_ITEMS})</span>
      </h3>

      {/* Uploaded items list */}
      {items && items.length > 0 && (
        <div className="media-item-list">
          {items.map((item, index) => (
            <div className="media-item-row" key={index}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                ) : (
                  <div style={{ width: 48, height: 48, background: 'var(--bg-secondary)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>
                    {item.type === 'video' ? '🎬' : '📷'}
                  </div>
                )}
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 0 }}>
                  <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{item.type}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    #{index + 1} of {items.length}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => onRemove(index)}
                style={{ flexShrink: 0 }}
              >
                ✕ Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add button / dropzone */}
      {canAddMore && (
        <div
          className="media-dropzone"
          style={items && items.length > 0 ? { marginTop: 10, padding: '14px 20px' } : {}}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED}
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          {uploading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div className="spinner" style={{ margin: 0 }} />Uploading to Telegram...</div>
          ) : items && items.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 20 }}>➕</span>
              <span style={{ fontWeight: 600 }}>Add Another ({items.length}/{MAX_ITEMS})</span>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 28, marginBottom: 6 }}>📤</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Upload Photo or Video</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>JPG, PNG, WEBP, MP4, MOV · Max {MAX_MB}MB · Up to {MAX_ITEMS} files</div>
            </div>
          )}
        </div>
      )}

      {!canAddMore && !uploading && items.length >= MAX_ITEMS && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>Maximum {MAX_ITEMS} media items reached.</div>
      )}

      {uploadError && <div className="alert alert-error" style={{ marginTop: 8, marginBottom: 0 }}>⚠️ {uploadError}</div>}
    </div>
  );
}

// ─────────────── Media Position Selector ───────────────
function MediaPositionSelector({ position, onChange, name }) {
  const radioName = name || 'media-position';
  return (
    <div className="media-position-selector">
      <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>📍 Media Position</h4>
      <div style={{ display: 'flex', gap: 16 }}>
        {['above', 'below'].map(pos => (
          <label key={pos} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
            <input
              type="radio"
              name={radioName}
              value={pos}
              checked={position === pos}
              onChange={() => onChange(pos)}
              style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
            />
            {pos === 'above' ? '⬆️ Above text' : '⬇️ Below text'}
          </label>
        ))}
      </div>
    </div>
  );
}

// ─────────────── Formatting Toolbar ───────────────
function FormattingToolbar({ textareaRef, value, onChange }) {
  const wrapSelection = (openTag, closeTag) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.substring(start, end);
    const before = value.substring(0, start);
    const after = value.substring(end);
    const newText = before + openTag + selected + closeTag + after;
    onChange(newText);
    setTimeout(() => {
      ta.focus();
      ta.selectionStart = start + openTag.length;
      ta.selectionEnd = start + openTag.length + selected.length;
    }, 0);
  };

  const insertLink = () => {
    const url = prompt('Enter URL:');
    if (!url) return;
    const ta = textareaRef.current;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.substring(start, end) || 'link text';
    const before = value.substring(0, start);
    const after = value.substring(end);
    const newText = before + `<a href="${url}">${selected}</a>` + after;
    onChange(newText);
    setTimeout(() => ta.focus(), 0);
  };

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      switch (e.key.toLowerCase()) {
        case 'b': e.preventDefault(); wrapSelection('<b>', '</b>'); break;
        case 'i': e.preventDefault(); wrapSelection('<i>', '</i>'); break;
        case 'u': e.preventDefault(); wrapSelection('<u>', '</u>'); break;
        case 'k': e.preventDefault(); insertLink(); break;
        default: break;
      }
    }
  };

  const buttons = [
    { label: 'B', title: 'Bold', fn: () => wrapSelection('<b>', '</b>'), shortcut: 'Ctrl+B', style: { fontWeight: 700 } },
    { label: 'I', title: 'Italic', fn: () => wrapSelection('<i>', '</i>'), shortcut: 'Ctrl+I', style: { fontStyle: 'italic' } },
    { label: 'U', title: 'Underline', fn: () => wrapSelection('<u>', '</u>'), shortcut: 'Ctrl+U', style: { textDecoration: 'underline' } },
    { label: 'S', title: 'Strikethrough', fn: () => wrapSelection('<s>', '</s>'), style: { textDecoration: 'line-through' } },
    'sep',
    { label: '</>', title: 'Monospace', fn: () => wrapSelection('<code>', '</code>'), style: { fontFamily: 'monospace', fontSize: 12 } },
    { label: '🔗', title: 'Link', fn: insertLink, shortcut: 'Ctrl+K' },
    { label: '👁', title: 'Spoiler', fn: () => wrapSelection('<tg-spoiler>', '</tg-spoiler>') },
    { label: '❝', title: 'Quote', fn: () => wrapSelection('<blockquote>', '</blockquote>') },
  ];

  return { handleKeyDown, toolbar: (
    <div className="formatting-toolbar">
      {buttons.map((btn, i) =>
        btn === 'sep' ? <div className="fmt-sep" key={i} /> : (
          <button
            key={i}
            type="button"
            className="fmt-btn"
            title={btn.title}
            onClick={btn.fn}
            style={btn.style}
          >
            {btn.label}
            {btn.shortcut && <span className="fmt-shortcut">{btn.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )};
}

// ─────────────── Login Page ───────────────
function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.login(username, password);
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h1>🚛 Driver Feedback</h1>
        <p className="subtitle">Admin Panel</p>
        {error && <div className="alert alert-error">⚠️ {error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username</label>
            <input
              className="form-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              required
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input
              className="form-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
            />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─────────────── Groups Page ───────────────
function GroupsPage() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getGroups();
      setGroups(data);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  const handleLanguageChange = async (groupId, language) => {
    try {
      await api.setGroupLanguage(groupId, language);
      setMessage({ type: 'success', text: 'Language updated successfully!' });
      fetchGroups();
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const langLabel = { en: '🇺🇸 English', ru: '🇷🇺 Russian', uz: '🇺🇿 Uzbek' };

  return (
    <div>
      <div className="page-header">
        <h2>Groups</h2>
        <p>Manage Telegram driver groups and their languages — <strong>{groups.length}</strong> group{groups.length !== 1 ? 's' : ''} registered</p>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.type === 'success' ? '✅' : '⚠️'} {message.text}
        </div>
      )}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading groups...</div>
      ) : groups.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <h3>No groups yet</h3>
          <p>Add the bot to a Telegram group to see it here.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Group Name</th>
                <th>Telegram ID</th>
                <th>Language</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td><strong>{g.group_name || 'Unknown'}</strong></td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{g.telegram_group_id}</td>
                  <td>
                    <select
                      className="form-select"
                      value={g.language}
                      onChange={(e) => handleLanguageChange(g.id, e.target.value)}
                      style={{ width: 160, padding: '8px 12px' }}
                    >
                      <option value="en">🇺🇸 English</option>
                      <option value="ru">🇷🇺 Russian</option>
                      <option value="uz">🇺🇿 Uzbek</option>
                    </select>
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    {g.created_at ? new Date(g.created_at).toLocaleDateString() : '—'}
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

// ─────────────── Questions Page ───────────────
function QuestionsPage() {
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState(null);
  const [sending, setSending] = useState(null);
  const [viewResponses, setViewResponses] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const [previewData, setPreviewData] = useState(null);

  const handlePreview = async (questionId) => {
    if (previewId === questionId) {
      setPreviewId(null);
      setPreviewData(null);
      return;
    }
    try {
      const q = await api.getQuestion(questionId);
      setPreviewData(q);
      setPreviewId(questionId);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const fetchQuestions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getQuestions();
      setQuestions(data);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchQuestions(); }, [fetchQuestions]);

  const handleSend = async (questionId) => {
    setSending(questionId);
    try {
      const result = await api.sendQuestion(questionId);
      setMessage({
        type: 'success',
        text: `Question sent! ${result.sent} group(s) received, ${result.failed} failed.`,
      });
      setTimeout(() => setMessage(null), 5000);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSending(null);
    }
  };

  const handleDeactivate = async (questionId) => {
    try {
      await api.deactivateQuestion(questionId);
      setMessage({ type: 'success', text: 'Question deactivated.' });
      fetchQuestions();
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const getEnglishText = (translations) => {
    if (!translations || !Array.isArray(translations)) return 'No text';
    const en = translations.find((t) => t.language === 'en');
    return en ? en.question_text : translations[0]?.question_text || 'No text';
  };

  if (viewResponses) {
    return (
      <ResponsesView
        questionId={viewResponses}
        onBack={() => setViewResponses(null)}
      />
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>Questions</h2>
        <p>Create and send survey questions to driver groups</p>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.type === 'success' ? '✅' : '⚠️'} {message.text}
        </div>
      )}

      <div className="action-bar">
        <div></div>
        <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? '✕ Cancel' : '＋ New Question'}
        </button>
      </div>

      {showCreate && (
        <CreateQuestionForm
          onCreated={() => {
            setShowCreate(false);
            fetchQuestions();
            setMessage({ type: 'success', text: 'Question created!' });
            setTimeout(() => setMessage(null), 3000);
          }}
          onError={(err) => setMessage({ type: 'error', text: err })}
        />
      )}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading questions...</div>
      ) : questions.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📝</div>
          <h3>No questions yet</h3>
          <p>Create your first question to get started.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {questions.map((q) => (
            <div className="card" key={q.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>#{q.id}</span>
                    <span className={`badge ${q.active ? 'badge-active' : 'badge-inactive'}`}>
                      {q.active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <p style={{ fontSize: 16, fontWeight: 500, marginBottom: 4 }}>
                    {getEnglishText(q.translations)}
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Created {q.created_at ? new Date(q.created_at).toLocaleString() : '—'}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => handlePreview(q.id)}
                  >
                    {previewId === q.id ? '✕ Close' : '👁 Preview'}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setViewResponses(q.id)}
                  >
                    📊 Responses
                  </button>
                  {q.active && (
                    <>
                      <button
                        className="btn btn-success btn-sm"
                        onClick={() => handleSend(q.id)}
                        disabled={sending === q.id}
                      >
                        {sending === q.id ? '⏳ Sending...' : '📤 Send'}
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleDeactivate(q.id)}
                      >
                        Deactivate
                      </button>
                    </>
                  )}
                </div>
              </div>
              {previewId === q.id && previewData && (
                <TelegramPreview
                  label="Telegram Preview"
                  text={`📋 ${(previewData.translations?.find(t => t.language === 'en')?.question_text) || 'Question'}`}
                  buttons={previewData.options?.map(o => {
                    const en = o.translations?.find(t => t.language === 'en');
                    return en ? en.option_text : `Option ${o.option_order}`;
                  }) || []}
                  langTabs={{
                    en: {
                      text: `📋 ${(previewData.translations?.find(t => t.language === 'en')?.question_text) || 'Question'}`,
                      buttons: previewData.options?.map(o => o.translations?.find(t => t.language === 'en')?.option_text || `Option ${o.option_order}`) || [],
                    },
                    ru: {
                      text: `📋 ${(previewData.translations?.find(t => t.language === 'ru')?.question_text) || ''}`,
                      buttons: previewData.options?.map(o => o.translations?.find(t => t.language === 'ru')?.option_text || '') || [],
                    },
                    uz: {
                      text: `📋 ${(previewData.translations?.find(t => t.language === 'uz')?.question_text) || ''}`,
                      buttons: previewData.options?.map(o => o.translations?.find(t => t.language === 'uz')?.option_text || '') || [],
                    },
                  }}
                  mediaItems={previewData.media_items || []}
                  mediaPosition={previewData.media_position}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────── Create Question Form ───────────────
function CreateQuestionForm({ onCreated, onError }) {
  const [questionEn, setQuestionEn] = useState('');
  const [questionRu, setQuestionRu] = useState('');
  const [questionUz, setQuestionUz] = useState('');
  const [options, setOptions] = useState([
    { en: '', ru: '', uz: '' },
    { en: '', ru: '', uz: '' },
    { en: '', ru: '', uz: '' },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState(null);
  const [testSuccess, setTestSuccess] = useState(false);
  // Media state: array of { file_id, type, previewUrl }
  const [mediaItems, setMediaItems] = useState([]);
  const [mediaPosition, setMediaPosition] = useState('above');

  const enRef = useRef(null);
  const ruRef = useRef(null);
  const uzRef = useRef(null);

  const fmtEn = FormattingToolbar({ textareaRef: enRef, value: questionEn, onChange: setQuestionEn });
  const fmtRu = FormattingToolbar({ textareaRef: ruRef, value: questionRu, onChange: setQuestionRu });
  const fmtUz = FormattingToolbar({ textareaRef: uzRef, value: questionUz, onChange: setQuestionUz });

  const updateOption = (index, lang, value) => {
    const updated = [...options];
    updated[index][lang] = value;
    setOptions(updated);
  };

  const addOption = () => {
    setOptions([...options, { en: '', ru: '', uz: '' }]);
  };

  const removeOption = (index) => {
    if (options.length <= 2) return;
    setOptions(options.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const translations = [
        { language: 'en', question_text: questionEn },
        { language: 'ru', question_text: questionRu },
        { language: 'uz', question_text: questionUz },
      ];

      const opts = options.map((opt, i) => ({
        option_order: i + 1,
        translations: [
          { language: 'en', option_text: opt.en },
          { language: 'ru', option_text: opt.ru },
          { language: 'uz', option_text: opt.uz },
        ],
      }));

      const payload = { translations, options: opts };
      if (mediaItems.length > 0) {
        payload.media_items = mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type }));
        payload.media_position = mediaPosition;
      }
      await api.createQuestion(payload);
      onCreated();
    } catch (err) {
      onError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendTest = async () => {
    if (!questionEn.trim()) {
      onError('English question text is required for test');
      return;
    }
    const enOptions = options.map((o) => o.en.trim()).filter(Boolean);
    if (enOptions.length < 2) {
      onError('At least 2 English options are required for test');
      return;
    }
    setSendingTest(true);
    try {
      await api.sendTestQuestion(questionEn.trim(), enOptions, mediaItems, mediaPosition);
      setTestSuccess(true);
      setTimeout(() => setTestSuccess(false), 4000);
    } catch (err) {
      onError(err.message);
    } finally {
      setSendingTest(false);
    }
  };

  const handleAutoTranslate = async () => {
    if (!questionEn.trim()) {
      setTranslateError('Please type the English question first.');
      return;
    }
    setTranslating(true);
    setTranslateError(null);
    try {
      const textBlocks = [questionEn, ...options.map(o => o.en).filter(Boolean)];
      const result = await api.translateTexts(textBlocks);
      // First item is question text, rest are options
      if (result.ru && result.ru[0]) setQuestionRu(result.ru[0]);
      if (result.uz && result.uz[0]) setQuestionUz(result.uz[0]);
      // Populate option translations
      const enOptionTexts = options.map(o => o.en).filter(Boolean);
      const updated = [...options];
      let idx = 1; // skip question text at index 0
      for (let i = 0; i < updated.length; i++) {
        if (updated[i].en.trim()) {
          if (result.ru && result.ru[idx]) updated[i].ru = result.ru[idx];
          if (result.uz && result.uz[idx]) updated[i].uz = result.uz[idx];
          idx++;
        }
      }
      setOptions(updated);
    } catch (err) {
      setTranslateError(err.message || 'Translation failed. Please try again.');
    } finally {
      setTranslating(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: 32 }}>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>📝 Question Translations</h3>
        <div className="translations-grid">
          <div className="lang-section">
            <h4><span className="badge badge-en">EN</span> English</h4>
            {fmtEn.toolbar}
            <textarea
              ref={enRef}
              className="form-textarea toolbar-textarea"
              value={questionEn}
              onChange={(e) => setQuestionEn(e.target.value)}
              onKeyDown={fmtEn.handleKeyDown}
              placeholder="Question in English"
              required
            />
          </div>
          <div className="lang-section">
            <h4><span className="badge badge-ru">RU</span> Russian</h4>
            {fmtRu.toolbar}
            <textarea
              ref={ruRef}
              className="form-textarea toolbar-textarea"
              value={questionRu}
              onChange={(e) => setQuestionRu(e.target.value)}
              onKeyDown={fmtRu.handleKeyDown}
              placeholder="Вопрос на русском"
              required
            />
          </div>
          <div className="lang-section">
            <h4><span className="badge badge-uz">UZ</span> Uzbek</h4>
            {fmtUz.toolbar}
            <textarea
              ref={uzRef}
              className="form-textarea toolbar-textarea"
              value={questionUz}
              onChange={(e) => setQuestionUz(e.target.value)}
              onKeyDown={fmtUz.handleKeyDown}
              placeholder="Savol o'zbek tilida"
              required
            />
          </div>
        </div>

        {translateError && (
          <div className="alert alert-error" style={{ marginTop: 12 }}>⚠️ {translateError}</div>
        )}

        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleAutoTranslate}
          disabled={translating || !questionEn.trim()}
          style={{ marginTop: 12, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {translating ? '⏳ Translating...' : '🌐 Auto Translate'}
        </button>
      </div>

      {questionEn.trim() && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>📱 Live Preview</h3>
          <TelegramPreview
            text={`📋 ${questionEn}`}
            buttons={options.map(o => o.en).filter(Boolean)}
            langTabs={{
              en: { text: `📋 ${questionEn}`, buttons: options.map(o => o.en).filter(Boolean) },
              ru: { text: questionRu ? `📋 ${questionRu}` : '', buttons: options.map(o => o.ru).filter(Boolean) },
              uz: { text: questionUz ? `📋 ${questionUz}` : '', buttons: options.map(o => o.uz).filter(Boolean) },
            }}
            mediaItems={mediaItems}
            mediaPosition={mediaPosition}
          />
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <MediaUploader
          items={mediaItems}
          onAdd={(m) => setMediaItems(prev => [...prev, m])}
          onRemove={(index) => setMediaItems(prev => prev.filter((_, i) => i !== index))}
        />
        {mediaItems.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <MediaPositionSelector name="question-media-position" position={mediaPosition} onChange={setMediaPosition} />
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>🔘 Answer Options</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={addOption}>
            ＋ Add Option
          </button>
        </div>

        {options.map((opt, i) => (
          <div className="option-row" key={i}>
            <div className="option-header">
              <h4>Option {i + 1}</h4>
              {options.length > 2 && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => removeOption(i)}
                  style={{ padding: '4px 12px', fontSize: 12 }}
                >
                  ✕ Remove
                </button>
              )}
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>🇺🇸 English</label>
              <input
                className="form-input"
                value={opt.en}
                onChange={(e) => updateOption(i, 'en', e.target.value)}
                placeholder="Option in English"
                required
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>🇷🇺 Russian</label>
              <input
                className="form-input"
                value={opt.ru}
                onChange={(e) => updateOption(i, 'ru', e.target.value)}
                placeholder="Вариант на русском"
                required
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>🇺🇿 Uzbek</label>
              <input
                className="form-input"
                value={opt.uz}
                onChange={(e) => updateOption(i, 'uz', e.target.value)}
                placeholder="O'zbek tilida variant"
                required
              />
            </div>
          </div>
        ))}
      </div>

      {testSuccess && (
        <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ Test question sent to management group!</div>
      )}
      <div style={{ display: 'flex', gap: 12 }}>
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? '⏳ Creating...' : '✅ Create Question'}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          onClick={handleSendTest}
          disabled={sendingTest}
          style={{ border: '1px solid var(--border)' }}
        >
          {sendingTest ? '⏳ Sending...' : '🧪 Send Test'}
        </button>
      </div>
    </form>
  );
}

// ─────────────── Responses View ───────────────
function ResponsesView({ questionId, onBack }) {
  const [responses, setResponses] = useState([]);
  const [question, setQuestion] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [q, r] = await Promise.all([
          api.getQuestion(questionId),
          api.getResponses(questionId),
        ]);
        setQuestion(q);
        setResponses(r);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [questionId]);

  const getEnglishText = (translations) => {
    if (!translations || !Array.isArray(translations)) return 'N/A';
    const en = translations.find((t) => t.language === 'en');
    return en ? en.question_text || en.option_text : translations[0]?.question_text || translations[0]?.option_text || 'N/A';
  };

  // Count answers by option
  const optionCounts = {};
  responses.forEach((r) => {
    const label = r.english_option || 'Unknown';
    optionCounts[label] = (optionCounts[label] || 0) + 1;
  });

  return (
    <div>
      <div className="page-header">
        <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 12 }}>
          ← Back to Questions
        </button>
        <h2>Responses for Question #{questionId}</h2>
        {question && (
          <p>{getEnglishText(question.translations)}</p>
        )}
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading responses...</div>
      ) : (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-value">{responses.length}</div>
              <div className="stat-label">Total Responses</div>
            </div>
            {Object.entries(optionCounts).map(([label, count]) => (
              <div className="stat-card" key={label}>
                <div className="stat-value">{count}</div>
                <div className="stat-label">{label}</div>
              </div>
            ))}
          </div>

          {responses.length === 0 ? (
            <div className="empty-state">
              <div className="icon">📭</div>
              <h3>No responses yet</h3>
              <p>Drivers haven't answered this question yet.</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th>Group</th>
                    <th>Answer</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {responses.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>
                          {r.username ? `@${r.username}` : `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Unknown'}
                        </strong>
                      </td>
                      <td>{r.group_name || 'Unknown'}</td>
                      <td>
                        <span className="badge badge-active">{r.english_option || 'N/A'}</span>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                        {r.answered_at ? new Date(r.answered_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────── Broadcast Page ───────────────
function BroadcastPage() {
  // ─── Tab state ───
  const [broadcastTab, setBroadcastTab] = React.useState('regular');

  // ─── Regular tab state ───
  const [message, setMessage] = useState('');
  const [messageRu, setMessageRu] = useState('');
  const [messageUz, setMessageUz] = useState('');
  const [status, setStatus] = useState(null);
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [broadcastMediaItems, setBroadcastMediaItems] = useState([]);
  const [broadcastMediaPosition, setBroadcastMediaPosition] = useState('above');
  const textareaRef = useRef(null);
  const ruBroadRef = useRef(null);
  const uzBroadRef = useRef(null);
  const { handleKeyDown, toolbar } = FormattingToolbar({ textareaRef, value: message, onChange: setMessage });
  const fmtRuBroad = FormattingToolbar({ textareaRef: ruBroadRef, value: messageRu, onChange: setMessageRu });
  const fmtUzBroad = FormattingToolbar({ textareaRef: uzBroadRef, value: messageUz, onChange: setMessageUz });

  // ─── Regular tab scheduling state ───
  const [sendMode, setSendMode] = useState('now');
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [targetType, setTargetType] = useState('all');
  const [selectedDriverIds, setSelectedDriverIds] = useState([]);
  const [selectedLanguages, setSelectedLanguages] = useState([]);
  const [forceLanguage, setForceLanguage] = useState('');
  const [driverGroups, setDriverGroups] = useState([]);
  const [scheduling, setScheduling] = useState(false);

  // ─── Regular broadcast history ───
  const [regularHistory, setRegularHistory] = useState([]);
  const [regularHistoryLoading, setRegularHistoryLoading] = useState(false);
  const [expandedRegularBroadcast, setExpandedRegularBroadcast] = useState(null);
  const [regularDeliveries, setRegularDeliveries] = useState({});

  // ─── Confirmation tab state ───
  const [confMessage, setConfMessage] = useState('');
  const [confMessageRu, setConfMessageRu] = useState('');
  const [confMessageUz, setConfMessageUz] = useState('');
  const [confStatus, setConfStatus] = useState(null);
  const [confSending, setConfSending] = useState(false);
  const [confTesting, setConfTesting] = useState(false);
  const [confTranslating, setConfTranslating] = useState(false);
  const [confMediaItems, setConfMediaItems] = useState([]);
  const [confMediaPosition, setConfMediaPosition] = useState('above');
  const confTextareaRef = useRef(null);
  const confRuRef = useRef(null);
  const confUzRef = useRef(null);
  const confFmt = FormattingToolbar({ textareaRef: confTextareaRef, value: confMessage, onChange: setConfMessage });
  const confFmtRu = FormattingToolbar({ textareaRef: confRuRef, value: confMessageRu, onChange: setConfMessageRu });
  const confFmtUz = FormattingToolbar({ textareaRef: confUzRef, value: confMessageUz, onChange: setConfMessageUz });

  // ─── Confirmation buttons state ───
  const [confirmationButtons, setConfirmationButtons] = useState([{ label_en: '', label_ru: '', label_uz: '' }]);
  const [confBtnTranslating, setConfBtnTranslating] = useState(false);

  // ─── Confirmation broadcast history ───
  const [confHistory, setConfHistory] = useState([]);
  const [confHistoryLoading, setConfHistoryLoading] = useState(false);
  const [expandedConfBroadcast, setExpandedConfBroadcast] = useState(null);
  const [confDeliveries, setConfDeliveries] = useState({});
  const [confClicks, setConfClicks] = useState({});
  const [expandedClicks, setExpandedClicks] = useState(null);

  useEffect(() => {
    api.getDriverGroups().then(setDriverGroups).catch(() => {});
  }, []);

  useEffect(() => {
    if (broadcastTab === 'regular') {
      loadRegularHistory();
    } else {
      loadConfHistory();
    }
  }, [broadcastTab]);

  const loadRegularHistory = async () => {
    setRegularHistoryLoading(true);
    try {
      const data = await api.getBroadcasts('regular');
      setRegularHistory(data);
    } catch (_) {}
    setRegularHistoryLoading(false);
  };

  const loadConfHistory = async () => {
    setConfHistoryLoading(true);
    try {
      const data = await api.getBroadcasts('confirmation');
      setConfHistory(data);
    } catch (_) {}
    setConfHistoryLoading(false);
  };

  const toggleRegularDeliveries = async (broadcastId) => {
    if (expandedRegularBroadcast === broadcastId) { setExpandedRegularBroadcast(null); return; }
    setExpandedRegularBroadcast(broadcastId);
    if (!regularDeliveries[broadcastId]) {
      try { const data = await api.getBroadcastDeliveries(broadcastId); setRegularDeliveries(prev => ({ ...prev, [broadcastId]: data })); } catch (_) {}
    }
  };

  const toggleConfDeliveries = async (broadcastId) => {
    if (expandedConfBroadcast === broadcastId) { setExpandedConfBroadcast(null); return; }
    setExpandedConfBroadcast(broadcastId);
    if (!confDeliveries[broadcastId]) {
      try { const data = await api.getBroadcastDeliveries(broadcastId); setConfDeliveries(prev => ({ ...prev, [broadcastId]: data })); } catch (_) {}
    }
  };

  const toggleConfClicks = async (broadcastId) => {
    if (expandedClicks === broadcastId) { setExpandedClicks(null); return; }
    setExpandedClicks(broadcastId);
    if (!confClicks[broadcastId]) {
      try { const data = await api.getBroadcastButtonClicks(broadcastId); setConfClicks(prev => ({ ...prev, [broadcastId]: data })); } catch (_) {}
    }
  };

  // ─── Regular tab handlers ───
  const toggleDriverId = (id) => setSelectedDriverIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleLanguage = (lang) => setSelectedLanguages(prev => prev.includes(lang) ? prev.filter(x => x !== lang) : [...prev, lang]);

  const handleAutoTranslate = async () => {
    if (!message.trim()) { setStatus({ type: 'error', text: 'Please type the English message first.' }); return; }
    setTranslating(true); setStatus(null);
    try {
      const result = await api.translateTexts([message]);
      if (result.ru && result.ru[0]) setMessageRu(result.ru[0]);
      if (result.uz && result.uz[0]) setMessageUz(result.uz[0]);
    } catch (err) { setStatus({ type: 'error', text: err.message || 'Translation failed. Please try again.' }); }
    finally { setTranslating(false); }
  };

  const handleSend = async () => {
    if (!message.trim()) { setStatus({ type: 'error', text: 'Message text is required' }); return; }
    if (message.length > 4096) { setStatus({ type: 'error', text: 'Message exceeds 4096 character limit' }); return; }
    setSending(true);
    try {
      const messages = (messageRu.trim() || messageUz.trim()) ? { en: message, ru: messageRu || message, uz: messageUz || message } : null;
      const result = await api.sendBroadcast(message, 'HTML', messages, broadcastMediaItems, broadcastMediaPosition);
      setStatus({ type: 'success', text: `Broadcast sent! ${result.sent} group(s) received, ${result.failed} failed.` });
      setTimeout(() => setStatus(null), 5000);
      loadRegularHistory();
    } catch (err) { setStatus({ type: 'error', text: err.message }); }
    finally { setSending(false); }
  };

  const handleTest = async () => {
    if (!message.trim()) { setStatus({ type: 'error', text: 'Message text is required' }); return; }
    setTesting(true);
    try {
      await api.sendBroadcastTest(message, 'HTML', broadcastMediaItems, broadcastMediaPosition);
      setStatus({ type: 'success', text: 'Test message sent to management group!' });
      setTimeout(() => setStatus(null), 3000);
    } catch (err) { setStatus({ type: 'error', text: err.message }); }
    finally { setTesting(false); }
  };

  const handleSchedule = async () => {
    if (!message.trim()) { setStatus({ type: 'error', text: 'English message text is required' }); return; }
    if (!scheduleDate || !scheduleTime) { setStatus({ type: 'error', text: 'Please select a date and time' }); return; }
    if (targetType === 'specific_drivers' && selectedDriverIds.length === 0) { setStatus({ type: 'error', text: 'Please select at least one driver' }); return; }
    if (targetType === 'language_groups' && selectedLanguages.length === 0) { setStatus({ type: 'error', text: 'Please select at least one language' }); return; }
    setScheduling(true);
    try {
      const scheduled_at_chicago = `${scheduleDate}T${scheduleTime}`;
      const data = {
        message_text_en: message.trim(),
        message_text_ru: messageRu.trim() || null,
        message_text_uz: messageUz.trim() || null,
        scheduled_at_chicago, target_type: targetType, force_language: forceLanguage || null,
      };
      if (targetType === 'specific_drivers') data.target_driver_ids = selectedDriverIds;
      if (targetType === 'language_groups') data.target_languages = selectedLanguages;
      if (broadcastMediaItems.length > 0) {
        data.media_file_id = broadcastMediaItems[0].file_id;
        data.media_type = broadcastMediaItems[0].type;
        data.media_position = broadcastMediaPosition;
      }
      await api.createScheduledMessage(data);
      setStatus({ type: 'success', text: `\u2705 Message scheduled for ${scheduleDate} ${scheduleTime} (Chicago time)` });
      setMessage(''); setMessageRu(''); setMessageUz('');
      setScheduleDate(''); setScheduleTime('09:00');
      setTargetType('all'); setSelectedDriverIds([]); setSelectedLanguages([]);
      setForceLanguage(''); setBroadcastMediaItems([]);
      setTimeout(() => setStatus(null), 5000);
    } catch (err) { setStatus({ type: 'error', text: err.message }); }
    finally { setScheduling(false); }
  };

  // ─── Confirmation tab handlers ───
  const handleConfAutoTranslate = async () => {
    if (!confMessage.trim()) { setConfStatus({ type: 'error', text: 'Please type the English message first.' }); return; }
    setConfTranslating(true); setConfStatus(null);
    try {
      const result = await api.translateTexts([confMessage]);
      if (result.ru && result.ru[0]) setConfMessageRu(result.ru[0]);
      if (result.uz && result.uz[0]) setConfMessageUz(result.uz[0]);
    } catch (err) { setConfStatus({ type: 'error', text: err.message || 'Translation failed. Please try again.' }); }
    finally { setConfTranslating(false); }
  };

  const handleConfAutoTranslateButtons = async () => {
    const enLabels = confirmationButtons.map(b => b.label_en);
    if (enLabels.every(l => !l.trim())) { setConfStatus({ type: 'error', text: 'Please fill in English button labels first.' }); return; }
    setConfBtnTranslating(true); setConfStatus(null);
    try {
      const result = await api.translateTexts(enLabels);
      setConfirmationButtons(prev => prev.map((btn, i) => ({
        ...btn,
        label_ru: (result.ru && result.ru[i]) || btn.label_ru,
        label_uz: (result.uz && result.uz[i]) || btn.label_uz,
      })));
    } catch (err) { setConfStatus({ type: 'error', text: err.message || 'Translation failed.' }); }
    finally { setConfBtnTranslating(false); }
  };

  const handleConfSend = async () => {
    if (!confMessage.trim()) { setConfStatus({ type: 'error', text: 'Message text is required' }); return; }
    if (confMessage.length > 4096) { setConfStatus({ type: 'error', text: 'Message exceeds 4096 character limit' }); return; }
    const validButtons = confirmationButtons.filter(b => b.label_en.trim());
    if (validButtons.length === 0) { setConfStatus({ type: 'error', text: 'At least one button with an English label is required' }); return; }
    setConfSending(true);
    try {
      const messages = (confMessageRu.trim() || confMessageUz.trim()) ? { en: confMessage, ru: confMessageRu || confMessage, uz: confMessageUz || confMessage } : null;
      const result = await api.sendConfirmationBroadcast(confMessage, 'HTML', messages, confMediaItems, confMediaPosition, validButtons);
      setConfStatus({ type: 'success', text: `Confirmation broadcast sent! ${result.sent} group(s) received, ${result.failed} failed.` });
      setTimeout(() => setConfStatus(null), 5000);
      loadConfHistory();
    } catch (err) { setConfStatus({ type: 'error', text: err.message }); }
    finally { setConfSending(false); }
  };

  const handleConfTest = async () => {
    if (!confMessage.trim()) { setConfStatus({ type: 'error', text: 'Message text is required' }); return; }
    setConfTesting(true);
    try {
      const validButtons = confirmationButtons.filter(b => b.label_en.trim());
      await api.sendConfirmationBroadcastTest(confMessage, 'HTML', confMediaItems, confMediaPosition, validButtons);
      setConfStatus({ type: 'success', text: 'Test message sent to management group!' });
      setTimeout(() => setConfStatus(null), 3000);
    } catch (err) { setConfStatus({ type: 'error', text: err.message }); }
    finally { setConfTesting(false); }
  };

  const addConfButton = () => setConfirmationButtons(prev => [...prev, { label_en: '', label_ru: '', label_uz: '' }]);
  const removeConfButton = (index) => setConfirmationButtons(prev => prev.filter((_, i) => i !== index));
  const updateConfButton = (index, field, value) => setConfirmationButtons(prev => prev.map((btn, i) => i === index ? { ...btn, [field]: value } : btn));

  const formatDate = (ts) => { try { return new Date(ts).toLocaleString(); } catch (_) { return ts || ''; } };
  const truncate = (text, max) => !text ? '' : text.length > max ? text.slice(0, max) + '...' : text;
  const getClickSummary = (clicks) => {
    const summary = {};
    (clicks || []).forEach(c => { const k = `Button ${c.button_index + 1}`; summary[k] = (summary[k] || 0) + 1; });
    return Object.entries(summary);
  };

  return (
    <div>
      <div className="page-header">
        <h2>Broadcast Message</h2>
        <p>Send announcements and messages to driver groups</p>
      </div>

      {/* ─── Tab Bar ─── */}
      <div className="broadcast-tabs">
        {[
          { val: 'regular', label: '\ud83d\udce2 Regular Broadcasting' },
          { val: 'confirmation', label: '\u2705 Driver Confirmation' },
        ].map(tab => (
          <button
            key={tab.val}
            type="button"
            className={'broadcast-tab-btn' + (broadcastTab === tab.val ? ' active' : '')}
            onClick={() => setBroadcastTab(tab.val)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ════════ TAB 1: REGULAR ════════ */}
      {broadcastTab === 'regular' && (
        <div>
          {status && <div className={`alert alert-${status.type}`}>{status.type === 'success' ? '\u2705' : '\u26a0\ufe0f'} {status.text}</div>}

          <div className="broadcast-layout">
            <div className="broadcast-editor-section">
              <div className="card">
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>\u270d\ufe0f Compose Message</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Use the toolbar to format text with Telegram-compatible HTML tags.</p>

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-en">EN</span> English</h4>
                {toolbar}
                <textarea
                  ref={textareaRef}
                  className="form-textarea toolbar-textarea"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your broadcast message here..."
                  style={{ minHeight: 140, resize: 'vertical' }}
                />
                <div className={`char-count ${message.length > 4096 ? 'over-limit' : ''}`}>{message.length} / 4096</div>

                <button type="button" className="btn btn-ghost" onClick={handleAutoTranslate} disabled={translating || !message.trim()}
                  style={{ marginTop: 12, marginBottom: 16, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {translating ? '\u23f3 Translating...' : '\ud83c\udf10 Auto Translate'}
                </button>

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-ru">RU</span> Russian</h4>
                {fmtRuBroad.toolbar}
                <textarea ref={ruBroadRef} className="form-textarea toolbar-textarea" value={messageRu} onChange={(e) => setMessageRu(e.target.value)} onKeyDown={fmtRuBroad.handleKeyDown}
                  placeholder="\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043d\u0430 \u0440\u0443\u0441\u0441\u043a\u043e\u043c (\u0430\u0432\u0442\u043e-\u043f\u0435\u0440\u0435\u0432\u043e\u0434 \u0438\u043b\u0438 \u0440\u0443\u0447\u043d\u043e\u0439 \u0432\u0432\u043e\u0434)" style={{ minHeight: 100, resize: 'vertical', marginBottom: 12 }} />

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-uz">UZ</span> Uzbek</h4>
                {fmtUzBroad.toolbar}
                <textarea ref={uzBroadRef} className="form-textarea toolbar-textarea" value={messageUz} onChange={(e) => setMessageUz(e.target.value)} onKeyDown={fmtUzBroad.handleKeyDown}
                  placeholder="O'zbek tilidagi xabar (avto-tarjima yoki qo'lda kiritish)" style={{ minHeight: 100, resize: 'vertical' }} />

                <div style={{ marginTop: 16 }}>
                  <MediaUploader items={broadcastMediaItems} onAdd={(m) => setBroadcastMediaItems(prev => [...prev, m])} onRemove={(index) => setBroadcastMediaItems(prev => prev.filter((_, i) => i !== index))} />
                  {broadcastMediaItems.length > 0 && <div style={{ marginTop: 16 }}><MediaPositionSelector name="broadcast-media-position" position={broadcastMediaPosition} onChange={setBroadcastMediaPosition} /></div>}
                </div>

                <div className="card" style={{ marginTop: 20, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>\u23f1\ufe0f Delivery</h3>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                    {[{ val: 'now', label: '\ud83d\udce4 Send Now' }, { val: 'schedule', label: '\ud83d\udd50 Schedule for Later' }].map(opt => (
                      <button key={opt.val} type="button" onClick={() => setSendMode(opt.val)} style={{ padding: '8px 20px', fontSize: 13, fontWeight: 600, borderRadius: 8, cursor: 'pointer', border: sendMode === opt.val ? '2px solid var(--primary)' : '1px solid var(--border)', background: sendMode === opt.val ? 'var(--primary)' : 'transparent', color: sendMode === opt.val ? '#fff' : 'var(--text-muted)' }}>{opt.label}</button>
                    ))}
                  </div>
                  {sendMode === 'schedule' && (
                    <>
                      <div style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>\ud83d\udcc5 Schedule Date &amp; Time <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(Chicago / Central Time)</span></h4>
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                          <input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} style={{ padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} />
                          <input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} style={{ padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} />
                        </div>
                      </div>
                      <div style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>\ud83c\udfaf Target Audience</h4>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                          {[{ val: 'all', label: '\ud83d\udc65 All Drivers' }, { val: 'specific_drivers', label: '\ud83d\ude9b Specific Drivers' }, { val: 'language_groups', label: '\ud83c\udf10 By Language' }].map(opt => (
                            <button key={opt.val} type="button" onClick={() => setTargetType(opt.val)} style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: 'pointer', border: targetType === opt.val ? '2px solid var(--accent)' : '1px solid var(--border)', background: targetType === opt.val ? 'rgba(139, 92, 246, 0.15)' : 'transparent', color: targetType === opt.val ? 'var(--accent)' : 'var(--text-muted)' }}>{opt.label}</button>
                          ))}
                        </div>
                        {targetType === 'specific_drivers' && (
                          <div style={{ maxHeight: 200, overflowY: 'auto', background: 'var(--bg-primary)', borderRadius: 8, border: '1px solid var(--border)', padding: 8 }}>
                            {driverGroups.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: 8 }}>No driver groups found.</p>
                              : driverGroups.map(g => (
                                <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer', borderRadius: 6, fontSize: 13 }}>
                                  <input type="checkbox" checked={selectedDriverIds.includes(g.id)} onChange={() => toggleDriverId(g.id)} style={{ accentColor: 'var(--accent)' }} />
                                  <span style={{ fontWeight: 600 }}>{g.group_name || 'Unknown'}</span>
                                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({g.language?.toUpperCase()})</span>
                                </label>
                              ))}
                          </div>
                        )}
                        {targetType === 'language_groups' && (
                          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                            {[{ val: 'en', label: '\ud83c\uddfa\ud83c\uddf8 English groups' }, { val: 'ru', label: '\ud83c\uddf7\ud83c\uddfa Russian groups' }, { val: 'uz', label: '\ud83c\uddfa\ud83c\uddff Uzbek groups' }].map(opt => (
                              <label key={opt.val} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                                <input type="checkbox" checked={selectedLanguages.includes(opt.val)} onChange={() => toggleLanguage(opt.val)} style={{ accentColor: 'var(--accent)' }} />
                                {opt.label}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                      <div>
                        <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>\ud83d\udcac Message Language</h4>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {[{ val: '', label: '\ud83d\udd04 Auto (default)' }, { val: 'en', label: '\ud83c\uddfa\ud83c\uddf8 English only' }, { val: 'ru', label: '\ud83c\uddf7\ud83c\uddfa Russian only' }, { val: 'uz', label: '\ud83c\uddfa\ud83c\uddff Uzbek only' }].map(opt => (
                            <button key={opt.val} type="button" onClick={() => setForceLanguage(opt.val)} style={{ padding: '5px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: 'pointer', border: forceLanguage === opt.val ? '2px solid var(--primary)' : '1px solid var(--border)', background: forceLanguage === opt.val ? 'var(--primary)' : 'transparent', color: forceLanguage === opt.val ? '#fff' : 'var(--text-muted)' }}>{opt.label}</button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                  {sendMode === 'now' ? (
                    <>
                      <button className="btn btn-primary" onClick={handleSend} disabled={sending || !message.trim() || message.length > 4096}>
                        {sending ? '\u23f3 Sending...' : '\ud83d\udce4 Send to All Groups'}
                      </button>
                      <button className="btn btn-ghost" onClick={handleTest} disabled={testing || !message.trim()} style={{ border: '1px solid var(--border)' }}>
                        {testing ? '\u23f3 Testing...' : '\ud83e\uddea Test'}
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-primary" onClick={handleSchedule} disabled={scheduling || !message.trim() || !scheduleDate || !scheduleTime} style={{ background: 'linear-gradient(135deg, var(--primary) 0%, var(--accent) 100%)' }}>
                      {scheduling ? '\u23f3 Scheduling...' : '\ud83d\udd50 Schedule Message'}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="broadcast-preview-section">
              <div className="card">
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>\ud83d\udcf1 Live Preview</h3>
                <TelegramPreview label="How it will look in Telegram" text={message}
                  langTabs={{ en: { text: message }, ru: { text: messageRu }, uz: { text: messageUz } }}
                  mediaItems={broadcastMediaItems} mediaPosition={broadcastMediaPosition} />
              </div>
            </div>
          </div>

          {/* ─── Regular Broadcast History ─── */}
          <div className="card broadcast-history" style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600 }}>\ud83d\udccb Broadcast History</h3>
              <button type="button" className="btn btn-ghost" onClick={loadRegularHistory} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>\ud83d\udd04 Refresh</button>
            </div>
            {regularHistoryLoading ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading...</div>
              : regularHistory.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No broadcasts sent yet.</div>
              : regularHistory.map(b => (
                <div key={b.id} className="broadcast-history-item">
                  <div className="broadcast-history-header" onClick={() => toggleRegularDeliveries(b.id)} style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{formatDate(b.created_at)}</span>
                      <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-muted)' }}>{truncate(b.message_text_en, 60)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className="badge" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>\u2705 {b.sent_count || 0}</span>
                      {Number(b.failed_count) > 0 && <span className="badge" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>\u274c {b.failed_count}</span>}
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expandedRegularBroadcast === b.id ? '\u25b2' : '\u25bc'}</span>
                    </div>
                  </div>
                  {expandedRegularBroadcast === b.id && (
                    <div className="delivery-list">
                      {(regularDeliveries[b.id] || []).length === 0
                        ? <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8 }}>No delivery data.</div>
                        : (regularDeliveries[b.id] || []).map(d => (
                          <div key={d.id} className="delivery-row">
                            <span style={{ fontSize: 13 }}>{d.group_name || `Group ${d.telegram_group_id}`}</span>
                            <span className={`delivery-badge ${d.status === 'sent' ? 'sent' : 'failed'}`}>{d.status === 'sent' ? '\u2705 Sent' : '\u274c Failed'}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ════════ TAB 2: CONFIRMATION ════════ */}
      {broadcastTab === 'confirmation' && (
        <div>
          {confStatus && <div className={`alert alert-${confStatus.type}`}>{confStatus.type === 'success' ? '\u2705' : '\u26a0\ufe0f'} {confStatus.text}</div>}

          <div className="broadcast-layout">
            <div className="broadcast-editor-section">
              <div className="card">
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>\u270d\ufe0f Compose Message</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Use the toolbar to format text with Telegram-compatible HTML tags.</p>

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-en">EN</span> English</h4>
                {confFmt.toolbar}
                <textarea ref={confTextareaRef} className="form-textarea toolbar-textarea" value={confMessage} onChange={(e) => setConfMessage(e.target.value)} onKeyDown={confFmt.handleKeyDown}
                  placeholder="Type your confirmation message here..." style={{ minHeight: 140, resize: 'vertical' }} />
                <div className={`char-count ${confMessage.length > 4096 ? 'over-limit' : ''}`}>{confMessage.length} / 4096</div>

                <button type="button" className="btn btn-ghost" onClick={handleConfAutoTranslate} disabled={confTranslating || !confMessage.trim()}
                  style={{ marginTop: 12, marginBottom: 16, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {confTranslating ? '\u23f3 Translating...' : '\ud83c\udf10 Auto Translate'}
                </button>

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-ru">RU</span> Russian</h4>
                {confFmtRu.toolbar}
                <textarea ref={confRuRef} className="form-textarea toolbar-textarea" value={confMessageRu} onChange={(e) => setConfMessageRu(e.target.value)} onKeyDown={confFmtRu.handleKeyDown}
                  placeholder="\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043d\u0430 \u0440\u0443\u0441\u0441\u043a\u043e\u043c (\u0430\u0432\u0442\u043e-\u043f\u0435\u0440\u0435\u0432\u043e\u0434 \u0438\u043b\u0438 \u0440\u0443\u0447\u043d\u043e\u0439 \u0432\u0432\u043e\u0434)" style={{ minHeight: 100, resize: 'vertical', marginBottom: 12 }} />

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-uz">UZ</span> Uzbek</h4>
                {confFmtUz.toolbar}
                <textarea ref={confUzRef} className="form-textarea toolbar-textarea" value={confMessageUz} onChange={(e) => setConfMessageUz(e.target.value)} onKeyDown={confFmtUz.handleKeyDown}
                  placeholder="O'zbek tilidagi xabar (avto-tarjima yoki qo'lda kiritish)" style={{ minHeight: 100, resize: 'vertical' }} />

                <div style={{ marginTop: 16 }}>
                  <MediaUploader items={confMediaItems} onAdd={(m) => setConfMediaItems(prev => [...prev, m])} onRemove={(index) => setConfMediaItems(prev => prev.filter((_, i) => i !== index))} />
                  {confMediaItems.length > 0 && <div style={{ marginTop: 16 }}><MediaPositionSelector name="conf-media-position" position={confMediaPosition} onChange={setConfMediaPosition} /></div>}
                </div>

                {/* ─── Inline Buttons Builder ─── */}
                <div className="card button-builder" style={{ marginTop: 20, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 600 }}>\ud83d\udd18 Inline Buttons</h3>
                    <button type="button" className="btn btn-ghost" onClick={handleConfAutoTranslateButtons} disabled={confBtnTranslating} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>
                      {confBtnTranslating ? '\u23f3' : '\ud83c\udf10'} Auto-translate Labels
                    </button>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Add buttons drivers can click. At least 1 button required to send.</p>
                  {confirmationButtons.map((btn, i) => (
                    <div key={i} className="button-builder-row">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', minWidth: 60 }}>Button {i + 1}</span>
                        {confirmationButtons.length > 1 && <button type="button" className="btn btn-danger btn-sm" onClick={() => removeConfButton(i)} style={{ marginLeft: 'auto' }}>\u2715</button>}
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 120 }}>
                          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>\ud83c\uddfa\ud83c\uddf8 EN</label>
                          <input className="form-input" style={{ width: '100%', fontSize: 13 }} value={btn.label_en} onChange={(e) => updateConfButton(i, 'label_en', e.target.value)} placeholder="Yes / Confirm" />
                        </div>
                        <div style={{ flex: 1, minWidth: 120 }}>
                          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>\ud83c\uddf7\ud83c\uddfa RU</label>
                          <input className="form-input" style={{ width: '100%', fontSize: 13 }} value={btn.label_ru} onChange={(e) => updateConfButton(i, 'label_ru', e.target.value)} placeholder="\u0414\u0430 / \u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044c" />
                        </div>
                        <div style={{ flex: 1, minWidth: 120 }}>
                          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>\ud83c\uddfa\ud83c\uddff UZ</label>
                          <input className="form-input" style={{ width: '100%', fontSize: 13 }} value={btn.label_uz} onChange={(e) => updateConfButton(i, 'label_uz', e.target.value)} placeholder="Ha / Tasdiqlash" />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button type="button" className="btn btn-ghost" onClick={addConfButton} style={{ marginTop: 8, fontSize: 13, border: '1px dashed var(--border)' }}>
                    \u2795 Add Button
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                  <button className="btn btn-primary" onClick={handleConfSend} disabled={confSending || !confMessage.trim() || confMessage.length > 4096}>
                    {confSending ? '\u23f3 Sending...' : '\ud83d\udce4 Send to All Groups'}
                  </button>
                  <button className="btn btn-ghost" onClick={handleConfTest} disabled={confTesting || !confMessage.trim()} style={{ border: '1px solid var(--border)' }}>
                    {confTesting ? '\u23f3 Testing...' : '\ud83e\uddea Test'}
                  </button>
                </div>
              </div>
            </div>

            <div className="broadcast-preview-section">
              <div className="card">
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>\ud83d\udcf1 Live Preview</h3>
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
              <h3 style={{ fontSize: 15, fontWeight: 600 }}>\ud83d\udccb Broadcast History</h3>
              <button type="button" className="btn btn-ghost" onClick={loadConfHistory} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>\ud83d\udd04 Refresh</button>
            </div>
            {confHistoryLoading ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading...</div>
              : confHistory.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No confirmation broadcasts sent yet.</div>
              : confHistory.map(b => (
                <div key={b.id} className="broadcast-history-item">
                  <div className="broadcast-history-header" style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={() => toggleConfDeliveries(b.id)}>
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{formatDate(b.created_at)}</span>
                      <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-muted)' }}>{truncate(b.message_text_en, 60)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className="badge" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>\u2705 {b.sent_count || 0}</span>
                      {Number(b.failed_count) > 0 && <span className="badge" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>\u274c {b.failed_count}</span>}
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expandedConfBroadcast === b.id ? '\u25b2' : '\u25bc'}</span>
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
                              <span className={`delivery-badge ${d.status === 'sent' ? 'sent' : 'failed'}`}>{d.status === 'sent' ? '\u2705 Sent' : '\u274c Failed'}</span>
                            </div>
                          ))}
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <button type="button" className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); toggleConfClicks(b.id); }} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>
                          {expandedClicks === b.id ? '\u25b2 Hide' : '\ud83d\udcca Show'} Click Tracking
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
      )}
    </div>
  );
}

// ─────────────── Employee Voting Page ───────────────
function EmployeeVotingPage() {
  const [polls, setPolls] = useState([]);
  const [selectedPoll, setSelectedPoll] = useState(null);
  const [results, setResults] = useState([]);
  const [voters, setVoters] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [status, setStatus] = useState(null);
  const [activeTab, setActiveTab] = useState('results');
  const [pollQuestion, setPollQuestion] = useState('Choose the best driver of the week in your opinion.');

  const loadPolls = async () => {
    try {
      const [p, u] = await Promise.all([api.getVotingPolls(), api.getDriverUnits()]);
      setPolls(p);
      setUnits(u);
      if (p.length > 0 && !selectedPoll) {
        setSelectedPoll(p[0]);
      }
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadPolls(); }, []);

  useEffect(() => {
    if (!selectedPoll) return;
    (async () => {
      try {
        const [r, v] = await Promise.all([
          api.getPollResults(selectedPoll.id),
          api.getPollVoters(selectedPoll.id),
        ]);
        setResults(r);
        setVoters(v);
      } catch (err) {
        setStatus({ type: 'error', text: err.message });
      }
    })();
  }, [selectedPoll]);

  const handleCreate = async () => {
    if (!pollQuestion.trim()) {
      setStatus({ type: 'error', text: 'Poll question cannot be empty.' });
      return;
    }
    if (units.length < 2) {
      setStatus({ type: 'error', text: 'At least 2 driver units are required to create a poll.' });
      return;
    }
    setCreating(true);
    setStatus(null);
    try {
      const result = await api.createVotingPoll(pollQuestion.trim());
      if (result.warning) {
        setStatus({ type: 'error', text: `⚠️ Poll created but NOT sent: ${result.warning}` });
      } else {
        setStatus({ type: 'success', text: '✅ Poll created and sent to employee group!' });
      }
      setSelectedPoll(null);
      await loadPolls();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setCreating(false);
    }
  };

  const handleClose = async () => {
    if (!selectedPoll) return;
    setClosing(true);
    try {
      await api.closePoll(selectedPoll.id);
      setStatus({ type: 'success', text: 'Poll closed. No more votes accepted.' });
      await loadPolls();
      setSelectedPoll(prev => prev ? { ...prev, status: 'closed' } : prev);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setClosing(false);
    }
  };

  const handleReset = async () => {
    if (!selectedPoll || !window.confirm('Reset ALL votes for this poll? This cannot be undone.')) return;
    setResetting(true);
    try {
      await api.resetPoll(selectedPoll.id);
      setStatus({ type: 'success', text: 'All votes reset.' });
      setResults([]);
      setVoters([]);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setResetting(false);
    }
  };

  if (loading) return <div className="loading"><div className="spinner" /> Loading...</div>;

  const activePoll = polls.find(p => p.status === 'active');
  const canCreate = !creating && !activePoll && units.length >= 2 && pollQuestion.trim().length > 0;

  return (
    <div>
      <div className="page-header">
        <h2>🏆 Employee Voting</h2>
        <p>Driver of the Week — create polls and track votes</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 16 }}>
          {status.text}
          <button onClick={() => setStatus(null)} style={{ float: 'right', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* Poll creation panel */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Create Driver of the Week Poll</h3>

        {/* Question input */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Poll Question</label>
          <input
            type="text"
            className="form-input"
            value={pollQuestion}
            onChange={e => setPollQuestion(e.target.value)}
            placeholder="Enter the poll question..."
            style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }}
          />
        </div>

        {/* Driver count and units preview */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: units.length >= 2 ? 'var(--text-primary)' : '#ef4444' }}>
            Total drivers available: {units.length}
          </span>
          {units.length < 2 && (
            <span style={{ fontSize: 12, color: '#ef4444' }}>⚠ Need at least 2 drivers</span>
          )}
          {activePoll && (
            <span style={{ fontSize: 12, background: '#16a34a22', color: '#4ade80', border: '1px solid #16a34a44', borderRadius: 6, padding: '4px 10px' }}>🟢 Active poll</span>
          )}
        </div>

        {units.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>📱 Telegram Preview</label>
            <div style={{ background: '#1a1a2e', borderRadius: 12, padding: 16, maxWidth: 420, border: '1px solid var(--border)' }}>
              {/* Message bubble */}
              <div style={{ background: '#2a2a4a', borderRadius: 10, padding: 12, marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>🏆 Driver of the Week</div>
                <div style={{ fontSize: 13, marginBottom: 6, color: '#e0e0e0' }}>{pollQuestion || '...'}</div>
                <div style={{ fontSize: 12, fontStyle: 'italic', color: '#999' }}>Tap a unit number below to cast your vote:</div>
              </div>
              {/* Inline buttons preview — 4 per row */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {units.map(u => (
                  <div key={u.unit_number} style={{
                    background: '#3b82f6', color: '#fff', fontSize: 12, fontWeight: 600,
                    borderRadius: 6, padding: '5px 10px', textAlign: 'center',
                    flex: `0 0 calc(${100 / Math.min(units.length, 4)}% - 4px)`,
                    minWidth: 50, maxWidth: 'calc(25% - 4px)',
                  }}>
                    #{u.unit_number}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <button
          className="btn btn-primary"
          onClick={handleCreate}
          disabled={!canCreate}
          title={activePoll ? 'Close the current active poll first' : units.length < 2 ? 'Need at least 2 drivers' : ''}
        >
          {creating ? '⏳ Creating...' : '🗳️ Create New Poll'}
        </button>
      </div>

      {/* Poll selector */}
      {polls.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ fontWeight: 600, fontSize: 14 }}>Poll:</label>
              <select
                value={selectedPoll?.id || ''}
                onChange={e => {
                  const p = polls.find(x => x.id === parseInt(e.target.value, 10));
                  setSelectedPoll(p || null);
                }}
                style={{ padding: '6px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13 }}
              >
                {polls.map(p => (
                  <option key={p.id} value={p.id}>
                    #{p.id} — {new Date(p.created_at).toLocaleDateString()} — {p.status.toUpperCase()} — {p.total_votes} votes
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{selectedPoll?.option_count} options</span>
            </div>
            {selectedPoll && (
              <div style={{ display: 'flex', gap: 8 }}>
                {selectedPoll.status === 'active' && (
                  <button className="btn btn-ghost btn-sm" onClick={handleClose} disabled={closing} style={{ border: '1px solid var(--border)' }}>
                    {closing ? '⏳' : '🔒 Close Poll'}
                  </button>
                )}
                <button className="btn btn-danger btn-sm" onClick={handleReset} disabled={resetting}>
                  {resetting ? '⏳' : '🔄 Reset Votes'}
                </button>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
            {['results', 'voters'].map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '6px 16px', fontSize: 13, fontWeight: 600, borderRadius: 6,
                  border: activeTab === tab ? '2px solid var(--primary)' : '1px solid var(--border)',
                  background: activeTab === tab ? 'var(--primary)' : 'transparent',
                  color: activeTab === tab ? '#fff' : 'var(--text-muted)',
                  cursor: 'pointer', textTransform: 'capitalize',
                }}
              >{tab === 'results' ? '📊 Results' : '👤 Voters'}</button>
            ))}
          </div>

          {/* Results table */}
          {activeTab === 'results' && (
            results.length === 0
              ? <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No votes yet.</p>
              : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="responses-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Unit</th>
                        <th>Driver</th>
                        <th>Company</th>
                        <th>Type</th>
                        <th>Votes</th>
                        <th>%</th>
                        <th style={{ width: 160 }}>Bar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r, i) => (
                        <tr key={r.id}>
                          <td><strong>#{r.unit_number}</strong>{i === 0 && r.vote_count > 0 && ' 🥇'}</td>
                          <td>{r.driver_name || '—'}</td>
                          <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.company_name || '—'}</td>
                          <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.driver_type || '—'}</td>
                          <td style={{ fontWeight: 700 }}>{r.vote_count}</td>
                          <td style={{ color: r.percentage > 0 ? 'var(--primary)' : 'var(--text-muted)' }}>{r.percentage}%</td>
                          <td>
                            <div style={{ background: 'var(--bg-secondary)', borderRadius: 4, overflow: 'hidden', height: 8 }}>
                              <div style={{ background: 'var(--primary)', width: `${r.percentage}%`, height: '100%', transition: 'width 0.3s' }} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          )}

          {/* Voters table */}
          {activeTab === 'voters' && (
            voters.length === 0
              ? <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No voters yet.</p>
              : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="responses-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Voter</th>
                        <th>Telegram ID</th>
                        <th>Chosen Unit</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {voters.map((v, i) => (
                        <tr key={i}>
                          <td>{v.telegram_first_name || ''}{v.telegram_username ? ` @${v.telegram_username}` : ''}</td>
                          <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{v.telegram_user_id}</td>
                          <td><strong>#{v.unit_number}</strong></td>
                          <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(v.created_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          )}
        </div>
      )}

      {polls.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🗳️</div>
          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>No polls yet</div>
          <div style={{ fontSize: 13 }}>Click "Create New Poll" to start the first Driver of the Week vote.</div>
        </div>
      )}
    </div>
  );
}

// ─────────────── Scheduled Messages Page ───────────────
function ScheduledMessagesPage() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);

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
    loadMessages();
    const interval = setInterval(loadMessages, 30000);
    return () => clearInterval(interval);
  }, [loadMessages]);

  const handleCancel = async (id) => {
    if (!window.confirm('Cancel this scheduled message?')) return;
    try {
      await api.cancelScheduledMessage(id);
      setStatus({ type: 'success', text: 'Message cancelled.' });
      loadMessages();
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    }
  };

  const handleSendNow = async (id) => {
    if (!window.confirm('Send this message immediately?')) return;
    try {
      const result = await api.sendScheduledMessageNow(id);
      setStatus({ type: 'success', text: `Message sent! ${result.sent} group(s) received, ${result.failed} failed.` });
      loadMessages();
      setTimeout(() => setStatus(null), 5000);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
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
                        <button className="btn btn-ghost btn-sm" onClick={() => handleSendNow(msg.id)} style={{ fontSize: 11, padding: '4px 10px' }}>
                          📤 Send Now
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleCancel(msg.id)} style={{ fontSize: 11, padding: '4px 10px' }}>
                          ✕ Cancel
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

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState('groups');

  useEffect(() => {
    (async () => {
      const token = localStorage.getItem('token');
      if (token) {
        const valid = await api.verifyAuth();
        if (!valid) localStorage.removeItem('token');
        setAuthed(valid);
      }
      setChecking(false);
    })();
  }, []);

  const handleLogout = () => {
    api.logout();
    setAuthed(false);
  };

  if (checking) {
    return (
      <div className="loading" style={{ minHeight: '100vh' }}>
        <div className="spinner"></div> Loading...
      </div>
    );
  }

  if (!authed) {
    return <LoginPage onLogin={() => setAuthed(true)} />;
  }

  const pages = {
    groups: <GroupsPage />,
    questions: <QuestionsPage />,
    broadcast: <BroadcastPage />,
    scheduled: <ScheduledMessagesPage />,
    voting: <EmployeeVotingPage />,
  };

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <h1>🚛 Driver Feedback</h1>
          <p>Admin Panel</p>
        </div>
        <nav className="sidebar-nav">
          <button
            className={`nav-item ${page === 'groups' ? 'active' : ''}`}
            onClick={() => setPage('groups')}
          >
            <span className="nav-icon">👥</span>
            Groups
          </button>
          <button
            className={`nav-item ${page === 'questions' ? 'active' : ''}`}
            onClick={() => setPage('questions')}
          >
            <span className="nav-icon">📝</span>
            Questions
          </button>
          <button
            className={`nav-item ${page === 'broadcast' ? 'active' : ''}`}
            onClick={() => setPage('broadcast')}
          >
            <span className="nav-icon">📢</span>
            Broadcast
          </button>
          <button
            className={`nav-item ${page === 'scheduled' ? 'active' : ''}`}
            onClick={() => setPage('scheduled')}
          >
            <span className="nav-icon">📅</span>
            Scheduled
          </button>
          <button
            className={`nav-item ${page === 'voting' ? 'active' : ''}`}
            onClick={() => setPage('voting')}
          >
            <span className="nav-icon">🏆</span>
            Employee Voting
          </button>
        </nav>
        <div className="sidebar-footer">
          <button className="logout-btn" onClick={handleLogout}>
            <span className="nav-icon">🚪</span>
            Sign Out
          </button>
        </div>
      </aside>
      <main className="main-content">
        {pages[page]}
      </main>
    </div>
  );
}
