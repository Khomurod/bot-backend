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
        <p>Manage Telegram driver groups and their languages</p>
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
  const [message, setMessage] = useState('');
  const [messageRu, setMessageRu] = useState('');
  const [messageUz, setMessageUz] = useState('');
  const [status, setStatus] = useState(null);
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [translating, setTranslating] = useState(false);
  // Media state: array of { file_id, type, previewUrl }
  const [broadcastMediaItems, setBroadcastMediaItems] = useState([]);
  const [broadcastMediaPosition, setBroadcastMediaPosition] = useState('above');
  const textareaRef = useRef(null);
  const ruBroadRef = useRef(null);
  const uzBroadRef = useRef(null);
  const { handleKeyDown, toolbar } = FormattingToolbar({ textareaRef, value: message, onChange: setMessage });
  const fmtRuBroad = FormattingToolbar({ textareaRef: ruBroadRef, value: messageRu, onChange: setMessageRu });
  const fmtUzBroad = FormattingToolbar({ textareaRef: uzBroadRef, value: messageUz, onChange: setMessageUz });

  const handleAutoTranslate = async () => {
    if (!message.trim()) {
      setStatus({ type: 'error', text: 'Please type the English message first.' });
      return;
    }
    setTranslating(true);
    setStatus(null);
    try {
      const result = await api.translateTexts([message]);
      if (result.ru && result.ru[0]) setMessageRu(result.ru[0]);
      if (result.uz && result.uz[0]) setMessageUz(result.uz[0]);
    } catch (err) {
      setStatus({ type: 'error', text: err.message || 'Translation failed. Please try again.' });
    } finally {
      setTranslating(false);
    }
  };

  const handleSend = async () => {
    if (!message.trim()) {
      setStatus({ type: 'error', text: 'Message text is required' });
      return;
    }
    if (message.length > 4096) {
      setStatus({ type: 'error', text: 'Message exceeds 4096 character limit' });
      return;
    }
    setSending(true);
    try {
      const messages = (messageRu.trim() || messageUz.trim())
        ? { en: message, ru: messageRu || message, uz: messageUz || message }
        : null;
      const result = await api.sendBroadcast(message, 'HTML', messages, broadcastMediaItems, broadcastMediaPosition);
      setStatus({ type: 'success', text: `Broadcast sent! ${result.sent} group(s) received, ${result.failed} failed.` });
      setTimeout(() => setStatus(null), 5000);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setSending(false);
    }
  };

  const handleTest = async () => {
    if (!message.trim()) {
      setStatus({ type: 'error', text: 'Message text is required' });
      return;
    }
    setTesting(true);
    try {
      await api.sendBroadcastTest(message, 'HTML', broadcastMediaItems, broadcastMediaPosition);
      setStatus({ type: 'success', text: 'Test message sent to management group!' });
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>Broadcast Message</h2>
        <p>Send announcements and messages to all driver groups</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`}>
          {status.type === 'success' ? '✅' : '⚠️'} {status.text}
        </div>
      )}

      <div className="broadcast-layout">
        <div className="broadcast-editor-section">
          <div className="card">
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>✍️ Compose Message</h3>
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
            <div className={`char-count ${message.length > 4096 ? 'over-limit' : ''}`}>
              {message.length} / 4096
            </div>

            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleAutoTranslate}
              disabled={translating || !message.trim()}
              style={{ marginTop: 12, marginBottom: 16, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {translating ? '⏳ Translating...' : '🌐 Auto Translate'}
            </button>

            <h4 style={{ marginBottom: 6 }}><span className="badge badge-ru">RU</span> Russian</h4>
            {fmtRuBroad.toolbar}
            <textarea
              ref={ruBroadRef}
              className="form-textarea toolbar-textarea"
              value={messageRu}
              onChange={(e) => setMessageRu(e.target.value)}
              onKeyDown={fmtRuBroad.handleKeyDown}
              placeholder="Сообщение на русском (авто-перевод или ручной ввод)"
              style={{ minHeight: 100, resize: 'vertical', marginBottom: 12 }}
            />

            <h4 style={{ marginBottom: 6 }}><span className="badge badge-uz">UZ</span> Uzbek</h4>
            {fmtUzBroad.toolbar}
            <textarea
              ref={uzBroadRef}
              className="form-textarea toolbar-textarea"
              value={messageUz}
              onChange={(e) => setMessageUz(e.target.value)}
              onKeyDown={fmtUzBroad.handleKeyDown}
              placeholder="O'zbek tilidagi xabar (avto-tarjima yoki qo'lda kiritish)"
              style={{ minHeight: 100, resize: 'vertical' }}
            />

            <div style={{ marginTop: 16 }}>
              <MediaUploader
                items={broadcastMediaItems}
                onAdd={(m) => setBroadcastMediaItems(prev => [...prev, m])}
                onRemove={(index) => setBroadcastMediaItems(prev => prev.filter((_, i) => i !== index))}
              />
              {broadcastMediaItems.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <MediaPositionSelector name="broadcast-media-position" position={broadcastMediaPosition} onChange={setBroadcastMediaPosition} />
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
              <button
                className="btn btn-primary"
                onClick={handleSend}
                disabled={sending || !message.trim() || message.length > 4096}
              >
                {sending ? '⏳ Sending...' : '📤 Send to All Groups'}
              </button>
              <button
                className="btn btn-ghost"
                onClick={handleTest}
                disabled={testing || !message.trim()}
                style={{ border: '1px solid var(--border)' }}
              >
                {testing ? '⏳ Testing...' : '🧪 Test'}
              </button>
            </div>
          </div>
        </div>

        <div className="broadcast-preview-section">
          <div className="card">
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>📱 Live Preview</h3>
            <TelegramPreview
              label="How it will look in Telegram"
              text={message}
              langTabs={{
                en: { text: message },
                ru: { text: messageRu },
                uz: { text: messageUz },
              }}
              mediaItems={broadcastMediaItems}
              mediaPosition={broadcastMediaPosition}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────── Main App ───────────────
export default function App() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState('groups');

  useEffect(() => {
    (async () => {
      const token = localStorage.getItem('token');
      if (token) {
        const valid = await api.verifyAuth();
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
