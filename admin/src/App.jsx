import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import * as api from './api';

function getDaysUntilBirthday(dateString) {
  if (!dateString) return Infinity;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const bday = new Date(dateString);
  let nextBday = new Date(today.getFullYear(), bday.getUTCMonth(), bday.getUTCDate());
  if (nextBday < today) {
    nextBday.setFullYear(today.getFullYear() + 1);
  }
  return Math.ceil((nextBday - today) / (1000 * 60 * 60 * 24));
}

// ─────────────── Telegram Message Preview ───────────────
const TelegramPreview = React.memo(function TelegramPreview({ text, buttons, label, langTabs, mediaItems, mediaPosition }) {
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
});

// ─────────────── Media Uploader (multi-file) ───────────────
// onAdd(item): item = { file_id, type, previewUrl }  — called when a file is uploaded
// onRemove(index): remove item at index
// items: [{ file_id, type, previewUrl }]
const MediaUploader = React.memo(function MediaUploader({ onAdd, onRemove, items }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const fileInputRef = useRef(null);
  const MAX_ITEMS = 10;
  const ACCEPTED = '.jpg,.jpeg,.png,.webp,.mp4,.mov';
  const MAX_MB = 20;

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files);
    if (!fileInputRef.current) return;
    fileInputRef.current.value = '';
    if (!files.length) return;

    if (items && items.length + files.length > MAX_ITEMS) {
      setUploadError(`Maximum ${MAX_ITEMS} media items allowed. You tried to add ${files.length} more.`);
      return;
    }

    for (const file of files) {
      if (file.size > MAX_MB * 1024 * 1024) {
        setUploadError(`File ${file.name} is too large. Maximum size is ${MAX_MB}MB.`);
        return;
      }
    }

    setUploadError(null);
    setUploading(true);
    setUploadProgress(`0 / ${files.length}`);

    let uploadedCount = 0;
    for (const file of files) {
      try {
        const result = await api.uploadMedia(file);
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
        onAdd({ file_id: result.file_id, type: result.media_type, previewUrl });
        uploadedCount++;
        setUploadProgress(`${uploadedCount} / ${files.length}`);
      } catch (err) {
        setUploadError(err.message || `Upload failed for ${file.name}.`);
        break; // Stop uploading further files if one fails
      }
    }
    setUploading(false);
    setUploadProgress(null);
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
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          {uploading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="spinner" style={{ margin: 0 }} />
              Uploading to Telegram... {uploadProgress && `(${uploadProgress})`}
            </div>
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
});

function MediaPositionSelector({ name, position, onChange }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: 'block' }}>🖼️ Media Position</label>
      <div style={{ display: 'flex', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="radio" name={name} value="above" checked={position === 'above'} onChange={() => onChange('above')} style={{ accentColor: 'var(--accent)' }} />
          Above Text
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="radio" name={name} value="below" checked={position === 'below'} onChange={() => onChange('below')} style={{ accentColor: 'var(--accent)' }} />
          Below Text
        </label>
      </div>
    </div>
  );
}

function useFormattingToolbar(textareaRef, value, onChange) {
  const insertTag = useCallback((tag) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.substring(start, end);
    const before = value.substring(0, start);
    const after = value.substring(end);
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const newVal = `${before}${open}${selected}${close}${after}`;
    onChange(newVal);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + open.length, start + open.length + selected.length);
    }, 10);
  }, [textareaRef, value, onChange]);

  const handleKeyDown = useCallback((e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      if (e.key === 'b') { e.preventDefault(); insertTag('b'); }
      if (e.key === 'i') { e.preventDefault(); insertTag('i'); }
      if (e.key === 'u') { e.preventDefault(); insertTag('u'); }
    }
  }, [insertTag]);

  const toolbar = (
    <div className="formatting-toolbar">
      <button type="button" onClick={() => insertTag('b')} title="Bold (Ctrl+B)"><b>B</b></button>
      <button type="button" onClick={() => insertTag('i')} title="Italic (Ctrl+I)"><i>I</i></button>
      <button type="button" onClick={() => insertTag('u')} title="Underline (Ctrl+U)"><u>U</u></button>
      <button type="button" onClick={() => insertTag('code')} title="Monospace"><code>&lt;/&gt;</code></button>
      <button type="button" onClick={() => insertTag('pre')} title="Code Block" style={{ fontSize: 13 }}>PRE</button>
      <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
      <button type="button" onClick={() => onChange(value + '<a href="URL">link</a>')} title="Link" style={{ fontSize: 13 }}>LINK</button>
    </div>
  );

  return { toolbar, handleKeyDown };
}

function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { token } = await api.login(username, password);
      localStorage.setItem('token', token);
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
        <div className="login-header">
          <h1>🚛 Driver Feedback</h1>
          <p>Sign in to access the admin panel</p>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
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
      const sorted = data.sort((a, b) => getDaysUntilBirthday(a.driver_birthday) - getDaysUntilBirthday(b.driver_birthday));
      setGroups(sorted);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      setLoading(true);
      try {
        const data = await api.getGroups();
        const sorted = data.sort((a, b) => getDaysUntilBirthday(a.driver_birthday) - getDaysUntilBirthday(b.driver_birthday));
        if (isMounted) setGroups(sorted);
      } catch (err) {
        if (isMounted) setMessage({ type: 'error', text: err.message });
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetchData();
    return () => { isMounted = false; };
  }, []);

  const handleLanguageChange = async (groupId, language) => {
    try {
      await api.setGroupLanguage(groupId, language);
      setMessage({ type: 'success', text: 'Language updated successfully!' });
      fetchGroups();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>👥 Driver Groups</h2>
        <p>Manage Telegram groups and driver languages</p>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading groups...</div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Group Name</th>
                <th>Telegram ID</th>
                <th>Driver Name</th>
                <th>Birthday</th>
                <th>Language</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(group => (
                <tr key={group.id}>
                  <td><strong>{group.group_name}</strong></td>
                  <td><code>{group.telegram_group_id}</code></td>
                  <td>{group.driver_first_name} {group.driver_last_name}</td>
                  <td>
                    {group.driver_birthday ? (
                      <span className={`badge ${getDaysUntilBirthday(group.driver_birthday) <= 7 ? 'badge-active' : ''}`}>
                        🎂 {new Date(group.driver_birthday).toLocaleDateString(undefined, { timeZone: 'UTC' })}
                        {getDaysUntilBirthday(group.driver_birthday) <= 7 && ` (in ${getDaysUntilBirthday(group.driver_birthday)}d)`}
                      </span>
                    ) : '-'}
                  </td>
                  <td>
                    <select
                      className="form-input"
                      style={{ width: 'auto', padding: '4px 8px' }}
                      value={group.language || ''}
                      onChange={(e) => handleLanguageChange(group.telegram_group_id, e.target.value)}
                    >
                      <option value="en">🇺🇸 English</option>
                      <option value="ru">🇷🇺 Russian</option>
                      <option value="uz">🇺🇿 Uzbek</option>
                    </select>
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
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [responses, setResponses] = useState({});

  const fetchQuestions = useCallback(async () => {
    try {
      const data = await api.getQuestions();
      setQuestions(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      try {
        const data = await api.getQuestions();
        if (isMounted) setQuestions(data);
      } catch (err) {
        if (isMounted) setError(err.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetchData();
    return () => { isMounted = false; };
  }, []);

  const toggleQuestion = async (id) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!responses[id]) {
      try {
        const data = await api.getResponses(id);
        setResponses(prev => ({ ...prev, [id]: data }));
      } catch (err) {
        console.error('Failed to fetch responses:', err);
      }
    }
  };

  const formatDate = (date) => new Date(date).toLocaleString();

  return (
    <div>
      <div className="page-header">
        <h2>📝 Driver Questions</h2>
        <p>View all questions and driver responses</p>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading questions...</div>
      ) : error ? (
        <div className="alert alert-error">{error}</div>
      ) : (
        <div className="questions-list">
          {questions.map(q => (
            <div key={q.id} className="card question-card">
              <div className="question-header" onClick={() => toggleQuestion(q.id)}>
                <div className="question-info">
                  <span className="question-date">{formatDate(q.created_at)}</span>
                  <h3>{q.text_en}</h3>
                </div>
                <div className="question-stats">
                  <span className="badge">{responses[q.id]?.length || 0} responses</span>
                  <span className="expand-icon">{expanded === q.id ? '▲' : '▼'}</span>
                </div>
              </div>

              {expanded === q.id && (
                <div className="responses-container">
                  {!responses[q.id] ? (
                    <div style={{ padding: 20, textAlign: 'center' }}>Loading responses...</div>
                  ) : responses[q.id].length === 0 ? (
                    <div className="empty-state" style={{ padding: 20 }}>No responses yet.</div>
                  ) : (
                    <table className="responses-table">
                      <thead>
                        <tr>
                          <th>Driver</th>
                          <th>Group</th>
                          <th>Response</th>
                          <th>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {responses[q.id].map(r => (
                          <tr key={r.id}>
                            <td>
                              <strong>{r.first_name} {r.last_name}</strong>
                              {r.username && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>@{r.username}</div>}
                            </td>
                            <td>{r.group_name}</td>
                            <td>{r.response_text}</td>
                            <td>{formatDate(r.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────── Chat Logs Page ───────────────
function ChatLogsPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchLogs = useCallback(async () => {
    try {
      const data = await api.getChatLogs();
      setLogs(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      try {
        const data = await api.getChatLogs();
        if (isMounted) setLogs(data);
      } catch (err) {
        if (isMounted) setError(err.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const formatDate = (date) => new Date(date).toLocaleString();

  return (
    <div>
      <div className="page-header">
        <h2>💬 Live Chat Logs</h2>
        <p>Real-time activity from all driver groups</p>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading logs...</div>
      ) : error ? (
        <div className="alert alert-error">{error}</div>
      ) : (
        <div className="logs-container card">
          <table className="logs-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Group</th>
                <th>Driver</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id}>
                  <td className="log-time">{formatDate(log.created_at)}</td>
                  <td><strong>{log.group_name}</strong></td>
                  <td>{log.first_name} {log.last_name}</td>
                  <td className="log-text">{log.message_text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────── Broadcast Page ───────────────
function BroadcastPage() {
  // Tabs
  const [broadcastTab, setBroadcastTab] = useState('regular'); // 'regular' | 'confirmation'

  // Common Target Selection
  const [targetType, setTargetType] = useState('all'); // 'all' | 'specific_drivers' | 'language_groups'
  const [selectedDriverIds, setSelectedDriverIds] = useState([]);
  const [selectedLanguages, setSelectedLanguages] = useState([]);
  const [driverGroups, setDriverGroups] = useState([]);

  // Regular Broadcast State
  const [message, setMessage] = useState('');
  const [messageRu, setMessageRu] = useState('');
  const [messageUz, setMessageUz] = useState('');
  const [forceLanguage, setForceLanguage] = useState(null);
  const [broadcastMediaItems, setBroadcastMediaItems] = useState([]);
  const [broadcastMediaPosition, setBroadcastMediaPosition] = useState('above');
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [status, setStatus] = useState(null);
  
  // History State
  const [regularHistory, setRegularHistory] = useState([]);
  const [regularHistoryLoading, setRegularHistoryLoading] = useState(false);
  const [expandedRegularBroadcast, setExpandedRegularBroadcast] = useState(null);
  const [regularDeliveries, setRegularDeliveries] = useState({});

  // Confirmation Broadcast State
  const [confMessage, setConfMessage] = useState('');
  const [confMessageRu, setConfMessageRu] = useState('');
  const [confMessageUz, setConfMessageUz] = useState('');
  const [confMediaItems, setConfMediaItems] = useState([]);
  const [confMediaPosition, setConfMediaPosition] = useState('above');
  const [confirmationButtons, setConfirmationButtons] = useState([{ label_en: 'Yes', label_ru: 'Да', label_uz: 'Ha' }]);
  const [confSending, setConfSending] = useState(false);
  const [confTesting, setConfTesting] = useState(false);
  const [confTranslating, setConfTranslating] = useState(false);
  const [confBtnTranslating, setConfBtnTranslating] = useState(false);
  const [confStatus, setConfStatus] = useState(null);

  // Conf History
  const [confHistory, setConfHistory] = useState([]);
  const [confHistoryLoading, setConfHistoryLoading] = useState(false);
  const [expandedConfBroadcast, setExpandedConfBroadcast] = useState(null);
  const [confDeliveries, setConfDeliveries] = useState({});
  const [confClicks, setConfClicks] = useState({});
  const [expandedClicks, setExpandedClicks] = useState(null);

  // Refs for toolbars
  const regTextareaRef = useRef(null);
  const regRuRef = useRef(null);
  const regUzRef = useRef(null);
  const confTextareaRef = useRef(null);
  const confRuRef = useRef(null);
  const confUzRef = useRef(null);

  // Toolbar setup
  const regFmt = useFormattingToolbar(regTextareaRef, message, setMessage);
  const regFmtRu = useFormattingToolbar(regRuRef, messageRu, setMessageRu);
  const regFmtUz = useFormattingToolbar(regUzRef, messageUz, setMessageUz);
  const confFmt = useFormattingToolbar(confTextareaRef, confMessage, setConfMessage);
  const confFmtRu = useFormattingToolbar(confRuRef, confMessageRu, setConfMessageRu);
  const confFmtUz = useFormattingToolbar(confUzRef, confMessageUz, setConfMessageUz);

  useEffect(() => {
    (async () => {
      try {
        const groups = await api.getGroups();
        setDriverGroups(groups.filter(g => g.group_type === 'driver'));
      } catch (err) { console.error(err); }
    })();
    loadRegularHistory();
    loadConfHistory();
  }, []);

  const loadRegularHistory = async () => {
    setRegularHistoryLoading(true);
    try {
      const data = await api.getBroadcastHistory('regular');
      setRegularHistory(data);
    } catch (err) { console.error(err); }
    setRegularHistoryLoading(false);
  };

  const loadConfHistory = async () => {
    setConfHistoryLoading(true);
    try {
      const data = await api.getBroadcastHistory('confirmation');
      setConfHistory(data);
    } catch (err) { console.error(err); }
    setConfHistoryLoading(false);
  };

  const toggleRegularDeliveries = async (id) => {
    if (expandedRegularBroadcast === id) {
      setExpandedRegularBroadcast(null);
      return;
    }
    setExpandedRegularBroadcast(id);
    if (!regularDeliveries[id]) {
      try {
        const data = await api.getBroadcastDeliveries(id);
        setRegularDeliveries(prev => ({ ...prev, [id]: data }));
      } catch (err) { console.error(err); }
    }
  };

  const toggleConfDeliveries = async (id) => {
    if (expandedConfBroadcast === id) {
      setExpandedConfBroadcast(null);
      return;
    }
    setExpandedConfBroadcast(id);
    if (!confDeliveries[id]) {
      try {
        const data = await api.getBroadcastDeliveries(id);
        setConfDeliveries(prev => ({ ...prev, [id]: data }));
      } catch (err) { console.error(err); }
    }
  };

  const toggleConfClicks = async (id) => {
    if (expandedClicks === id) {
      setExpandedClicks(null);
      return;
    }
    setExpandedClicks(id);
    if (!confClicks[id]) {
      try {
        const data = await api.getConfirmationClicks(id);
        setConfClicks(prev => ({ ...prev, [id]: data }));
      } catch (err) { console.error(err); }
    }
  };

  const getClickSummary = (clicks) => {
    const summary = {};
    clicks.forEach(c => {
      summary[c.button_label_en] = (summary[c.button_label_en] || 0) + 1;
    });
    return Object.entries(summary);
  };

  const toggleDriverId = (id) => {
    setSelectedDriverIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleLanguage = (lang) => {
    setSelectedLanguages(prev => prev.includes(lang) ? prev.filter(x => x !== lang) : [...prev, lang]);
  };

  const handleAutoTranslate = async () => {
    if (!message.trim()) return;
    setTranslating(true);
    try {
      const { ru, uz } = await api.translateBroadcast(message);
      setMessageRu(ru);
      setMessageUz(uz);
    } catch (err) {
      setStatus({ type: 'error', text: 'Translation failed: ' + err.message });
    } finally {
      setTranslating(false);
    }
  };

  const handleConfAutoTranslate = async () => {
    if (!confMessage.trim()) return;
    setConfTranslating(true);
    try {
      const { ru, uz } = await api.translateBroadcast(confMessage);
      setConfMessageRu(ru);
      setConfMessageUz(uz);
    } catch (err) {
      setConfStatus({ type: 'error', text: 'Translation failed: ' + err.message });
    } finally {
      setConfTranslating(false);
    }
  };

  const handleConfAutoTranslateButtons = async () => {
    setConfBtnTranslating(true);
    try {
      const updated = await Promise.all(confirmationButtons.map(async btn => {
        if (!btn.label_en.trim()) return btn;
        const { ru, uz } = await api.translateBroadcast(btn.label_en);
        return { ...btn, label_ru: ru, label_uz: uz };
      }));
      setConfirmationButtons(updated);
    } catch (err) {
      setConfStatus({ type: 'error', text: 'Button translation failed: ' + err.message });
    } finally {
      setConfBtnTranslating(false);
    }
  };

  const addConfButton = () => setConfirmationButtons([...confirmationButtons, { label_en: '', label_ru: '', label_uz: '' }]);
  const removeConfButton = (i) => setConfirmationButtons(confirmationButtons.filter((_, idx) => idx !== i));
  const updateConfButton = (i, field, val) => {
    const updated = [...confirmationButtons];
    updated[i][field] = val;
    setConfirmationButtons(updated);
  };

  const handleSend = async () => {
    if (!message.trim()) return;
    if (targetType === 'specific_drivers' && selectedDriverIds.length === 0) {
      return setStatus({ type: 'error', text: 'Please select at least one driver.' });
    }
    if (targetType === 'language_groups' && selectedLanguages.length === 0) {
      return setStatus({ type: 'error', text: 'Please select at least one language.' });
    }

    setSending(true);
    setStatus(null);
    try {
      const result = await api.sendBroadcast({
        type: 'regular',
        messageEn: message,
        messageRu,
        messageUz,
        forceLanguage,
        targetType,
        selectedDriverIds,
        selectedLanguages,
        mediaItems: broadcastMediaItems,
        mediaPosition: broadcastMediaPosition,
      });
      setStatus({ type: 'success', text: `Broadcast sent! Sent: ${result.sent}, Failed: ${result.failed}` });
      setMessage(''); setMessageRu(''); setMessageUz('');
      setBroadcastMediaItems([]);
      loadRegularHistory();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setSending(false);
    }
  };

  const handleTest = async () => {
    if (!message.trim()) return;
    setTesting(true);
    setStatus(null);
    try {
      await api.testBroadcast({
        type: 'regular',
        messageEn: message,
        messageRu,
        messageUz,
        forceLanguage,
        mediaItems: broadcastMediaItems,
        mediaPosition: broadcastMediaPosition,
      });
      setStatus({ type: 'success', text: 'Test broadcast sent to the management group.' });
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleConfSend = async () => {
    if (!confMessage.trim()) return;
    setConfSending(true);
    setConfStatus(null);
    try {
      const result = await api.sendBroadcast({
        type: 'confirmation',
        messageEn: confMessage,
        messageRu: confMessageRu,
        messageUz: confMessageUz,
        buttons: confirmationButtons,
        mediaItems: confMediaItems,
        mediaPosition: confMediaPosition,
      });
      setConfStatus({ type: 'success', text: `Confirmation broadcast sent! Sent: ${result.sent}, Failed: ${result.failed}` });
      setConfMessage(''); setConfMessageRu(''); setConfMessageUz('');
      setConfMediaItems([]);
      loadConfHistory();
    } catch (err) {
      setConfStatus({ type: 'error', text: err.message });
    } finally {
      setConfSending(false);
    }
  };

  const handleConfTest = async () => {
    if (!confMessage.trim()) return;
    setConfTesting(true);
    setConfStatus(null);
    try {
      await api.testBroadcast({
        type: 'confirmation',
        messageEn: confMessage,
        messageRu: confMessageRu,
        messageUz: confMessageUz,
        buttons: confirmationButtons,
        mediaItems: confMediaItems,
        mediaPosition: confMediaPosition,
      });
      setConfStatus({ type: 'success', text: 'Test confirmation sent to the management group.' });
    } catch (err) {
      setConfStatus({ type: 'error', text: err.message });
    } finally {
      setConfTesting(false);
    }
  };

  const formatDate = (d) => new Date(d).toLocaleString();
  const truncate = (s, n) => s?.length > n ? s.substring(0, n) + '...' : s;

  return (
    <div>
      <div className="page-header">
        <h2>📢 Broadcast Center</h2>
        <p>Send messages and media to multiple driver groups</p>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
        <button className={`nav-item ${broadcastTab === 'regular' ? 'active' : ''}`} onClick={() => setBroadcastTab('regular')} style={{ padding: '8px 20px', fontSize: 14 }}>Regular Broadcast</button>
        <button className={`nav-item ${broadcastTab === 'confirmation' ? 'active' : ''}`} onClick={() => setBroadcastTab('confirmation')} style={{ padding: '8px 20px', fontSize: 14 }}>Confirmation (Buttons)</button>
      </div>

      {/* ════════ TAB 1: REGULAR ════════ */}
      {broadcastTab === 'regular' && (
        <div>
          {status && <div className={`alert alert-${status.type}`}>{status.type === 'success' ? '✅' : '⚠️'} {status.text}</div>}

          <div className="broadcast-layout">
            <div className="broadcast-editor-section">
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <h3 style={{ fontSize: 16, fontWeight: 600 }}>✍️ Compose Message</h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Force Language:</label>
                    <select className="form-input" style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }} value={forceLanguage || ''} onChange={(e) => setForceLanguage(e.target.value || null)}>
                      <option value="">🔄 Auto (Group Default)</option>
                      <option value="en">🇺🇸 EN</option>
                      <option value="ru">🇷🇺 RU</option>
                      <option value="uz">🇺🇿 UZ</option>
                    </select>
                  </div>
                </div>

                <details className="collapse-panel" style={{ marginBottom: 16 }}>
                  <summary>🎯 Target Groups</summary>
                  <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
                    <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input type="radio" name="target" value="all" checked={targetType === 'all'} onChange={() => setTargetType('all')} style={{ accentColor: 'var(--accent)' }} />
                        All Groups
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input type="radio" name="target" value="specific_drivers" checked={targetType === 'specific_drivers'} onChange={() => setTargetType('specific_drivers')} style={{ accentColor: 'var(--accent)' }} />
                        Specific Drivers
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input type="radio" name="target" value="language_groups" checked={targetType === 'language_groups'} onChange={() => setTargetType('language_groups')} style={{ accentColor: 'var(--accent)' }} />
                        By Language
                      </label>
                    </div>

                    {targetType === 'specific_drivers' && (
                      <div style={{ maxHeight: 200, overflowY: 'auto', background: 'var(--bg-primary)', borderRadius: 8, border: '1px solid var(--border)', padding: 8, marginBottom: 16 }}>
                        {driverGroups.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: 8 }}>No driver groups found.</p> : (
                          <>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, paddingRight: 8 }}>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
                                if (selectedDriverIds.length === driverGroups.length) {
                                  setSelectedDriverIds([]);
                                } else {
                                  setSelectedDriverIds(driverGroups.map(g => g.id));
                                }
                              }} style={{ padding: '4px 8px', fontSize: 11 }}>
                                {selectedDriverIds.length === driverGroups.length ? 'Deselect All' : 'Select All'}
                              </button>
                            </div>
                            {driverGroups.map(g => (
                              <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer', borderRadius: 6, fontSize: 13 }}>
                                <input type="checkbox" checked={selectedDriverIds.includes(g.id)} onChange={() => toggleDriverId(g.id)} style={{ accentColor: 'var(--accent)' }} />
                                <span style={{ fontWeight: 600 }}>{g.group_name || 'Unknown'}</span>
                                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({g.language?.toUpperCase()})</span>
                              </label>
                            ))}
                          </>
                        )}
                      </div>
                    )}

                    {targetType === 'language_groups' && (
                      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                        {['en', 'ru', 'uz'].map(l => (
                          <label key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', background: 'var(--bg-primary)', padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                            <input type="checkbox" checked={selectedLanguages.includes(l)} onChange={() => toggleLanguage(l)} style={{ accentColor: 'var(--accent)' }} />
                            {l.toUpperCase()}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </details>

                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Use the toolbar to format text with Telegram-compatible HTML tags.</p>

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-en">EN</span> English</h4>
                {regFmt.toolbar}
                <textarea ref={regTextareaRef} className="form-textarea toolbar-textarea" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={regFmt.handleKeyDown}
                  placeholder="Type your message here..." style={{ minHeight: 140, resize: 'vertical' }} />
                <div className={`char-count ${message.length > 4096 ? 'over-limit' : ''}`}>{message.length} / 4096</div>

                <button type="button" className="btn btn-ghost" onClick={handleAutoTranslate} disabled={translating || !message.trim()}
                  style={{ marginTop: 12, marginBottom: 16, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {translating ? '⏳ Translating...' : '🌐 Auto Translate'}
                </button>

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-ru">RU</span> Russian</h4>
                {regFmtRu.toolbar}
                <textarea ref={regRuRef} className="form-textarea toolbar-textarea" value={messageRu} onChange={(e) => setMessageRu(e.target.value)} onKeyDown={regFmtRu.handleKeyDown}
                  placeholder="Сообщение на русском (авто-перевод или ручной ввод)" style={{ minHeight: 100, resize: 'vertical', marginBottom: 12 }} />

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-uz">UZ</span> Uzbek</h4>
                {regFmtUz.toolbar}
                <textarea ref={regUzRef} className="form-textarea toolbar-textarea" value={messageUz} onChange={(e) => setMessageUz(e.target.value)} onKeyDown={regFmtUz.handleKeyDown}
                  placeholder="O'zbek tilidagi xabar (avto-tarjima yoki qo'lda kiritish)" style={{ minHeight: 100, resize: 'vertical' }} />

                <details className="collapse-panel" style={{ marginTop: 16 }}>
                  <summary>📎 Media Attachments</summary>
                  <div style={{ marginTop: 12 }}>
                    <MediaUploader items={broadcastMediaItems} onAdd={(m) => setBroadcastMediaItems(prev => [...prev, m])} onRemove={(index) => setBroadcastMediaItems(prev => prev.filter((_, i) => i !== index))} />
                    {broadcastMediaItems.length > 0 && <div style={{ marginTop: 16 }}><MediaPositionSelector name="broadcast-media-position" position={broadcastMediaPosition} onChange={setBroadcastMediaPosition} /></div>}
                  </div>
                </details>

                <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
                  <button className="btn btn-primary" onClick={handleSend} disabled={sending || !message.trim() || message.length > 4096}>
                    {sending ? '⏳ Sending...' : targetType === 'all' ? '📤 Send to All Groups' : '📤 Send to Selected'}
                  </button>
                  <button className="btn btn-ghost" onClick={handleTest} disabled={testing || !message.trim()} style={{ border: '1px solid var(--border)' }}>
                    {testing ? '⏳ Testing...' : '🧪 Test (Management Group)'}
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
                  <div className="broadcast-history-header" onClick={() => toggleRegularDeliveries(b.id)} style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
                            <span className={`delivery-badge ${d.status === 'sent' ? 'sent' : 'failed'}`}>{d.status === 'sent' ? '✅ Sent' : '❌ Failed'}</span>
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
          {confStatus && <div className={`alert alert-${confStatus.type}`}>{confStatus.type === 'success' ? '✅' : '⚠️'} {confStatus.text}</div>}

          <div className="broadcast-layout">
            <div className="broadcast-editor-section">
              <div className="card">
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>✍️ Compose Message</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Use the toolbar to format text with Telegram-compatible HTML tags.</p>

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-en">EN</span> English</h4>
                {confFmt.toolbar}
                <textarea ref={confTextareaRef} className="form-textarea toolbar-textarea" value={confMessage} onChange={(e) => setConfMessage(e.target.value)} onKeyDown={confFmt.handleKeyDown}
                  placeholder="Type your confirmation message here..." style={{ minHeight: 140, resize: 'vertical' }} />
                <div className={`char-count ${confMessage.length > 4096 ? 'over-limit' : ''}`}>{confMessage.length} / 4096</div>

                <button type="button" className="btn btn-ghost" onClick={handleConfAutoTranslate} disabled={confTranslating || !confMessage.trim()}
                  style={{ marginTop: 12, marginBottom: 16, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {confTranslating ? '⏳ Translating...' : '🌐 Auto Translate'}
                </button>

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-ru">RU</span> Russian</h4>
                {confFmtRu.toolbar}
                <textarea ref={confRuRef} className="form-textarea toolbar-textarea" value={confMessageRu} onChange={(e) => setConfMessageRu(e.target.value)} onKeyDown={confFmtRu.handleKeyDown}
                  placeholder="Сообщение на русском (авто-перевод или ручной ввод)" style={{ minHeight: 100, resize: 'vertical', marginBottom: 12 }} />

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

                <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                  <button className="btn btn-primary" onClick={handleConfSend} disabled={confSending || !confMessage.trim() || confMessage.length > 4096}>
                    {confSending ? '⏳ Sending...' : '📤 Send Broadcast'}
                  </button>
                  <button className="btn btn-ghost" onClick={handleConfTest} disabled={confTesting || !confMessage.trim()} style={{ border: '1px solid var(--border)' }}>
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
                  <div className="broadcast-history-header" style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={() => toggleConfDeliveries(b.id)}>
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
                              <span className={`delivery-badge ${d.status === 'sent' ? 'sent' : 'failed'}`}>{d.status === 'sent' ? '✅ Sent' : '❌ Failed'}</span>
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
          disabled={!canCreate || creating}
          title={activePoll ? 'Close the current active poll first' : units.length < 2 ? 'Need at least 2 drivers' : ''}
        >
          {creating ? '⏳ Creating...' : '🗳️ Create Poll & Send to Telegram'}
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

/** Combined company report HTML for Telegram-style preview (admin-trusted content). */
function buildCompanyReportPreviewHtml(overall, breakdown) {
  const sanitize = (html) =>
    String(html || '')
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/\n/g, '<br/>');
  const o = sanitize(overall);
  const b = sanitize(breakdown);
  if (!o && !b) return '';
  if (!o) return b;
  if (!b) return o;
  return `${o}<br/><br/>${b}`;
}

function AiFeaturesPage() {
  const [activeTab, setActiveTab] = useState('driver');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [driverGroups, setDriverGroups] = useState([]);
  const [driverGroupId, setDriverGroupId] = useState('');
  const [driverDaysBack, setDriverDaysBack] = useState(7);
  const [companyDaysBack, setCompanyDaysBack] = useState(7);
  const [driverDrafts, setDriverDrafts] = useState([]);
  const [companyDrafts, setCompanyDrafts] = useState([]);
  const [companyHistory, setCompanyHistory] = useState([]);
  const [selectedDriverDraftId, setSelectedDriverDraftId] = useState(null);
  const [selectedCompanyDraftId, setSelectedCompanyDraftId] = useState(null);
  const [driverOverall, setDriverOverall] = useState('');
  const [driverBreakdown, setDriverBreakdown] = useState('');
  const [companyOverall, setCompanyOverall] = useState('');
  const [companyBreakdown, setCompanyBreakdown] = useState('');
  const [loading, setLoading] = useState(true);

  const parseDraft = (reportText) => {
    const [overall, breakdown] = String(reportText || '').split('|||');
    return {
      overall: (overall || '').trim(),
      breakdown: (breakdown || '').trim(),
    };
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [groups, driver, company] = await Promise.all([
        api.getDriverGroups(),
        api.getAiReports('driver'),
        api.getAiReports('company', true),
      ]);
      setDriverGroups(groups);
      if (!driverGroupId && groups.length > 0) setDriverGroupId(String(groups[0].id));

      setDriverDrafts(driver);
      setCompanyHistory(company);
      setCompanyDrafts(company.filter((r) => r.status === 'draft'));

      const driverSelected = driver.find((r) => r.id === selectedDriverDraftId) || driver[0] || null;
      if (driverSelected) {
        const parts = parseDraft(driverSelected.report_text);
        setSelectedDriverDraftId(driverSelected.id);
        setDriverOverall(parts.overall);
        setDriverBreakdown(parts.breakdown);
      } else {
        setSelectedDriverDraftId(null);
        setDriverOverall('');
        setDriverBreakdown('');
      }

      const companyDraftPool = company.filter((r) => r.status === 'draft');
      const companySelected = companyDraftPool.find((r) => r.id === selectedCompanyDraftId) || companyDraftPool[0] || null;
      if (companySelected) {
        const parts = parseDraft(companySelected.report_text);
        setSelectedCompanyDraftId(companySelected.id);
        setCompanyOverall(parts.overall);
        setCompanyBreakdown(parts.breakdown);
      } else {
        setSelectedCompanyDraftId(null);
        setCompanyOverall('');
        setCompanyBreakdown('');
      }
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, [driverGroupId, selectedCompanyDraftId, selectedDriverDraftId]);

  useEffect(() => { loadData(); }, [loadData]);

  const selectedDriverDraft = driverDrafts.find((d) => d.id === selectedDriverDraftId) || null;
  const selectedCompanyDraft = companyDrafts.find((d) => d.id === selectedCompanyDraftId) || null;

  const companyReportPreviewHtml = useMemo(
    () => buildCompanyReportPreviewHtml(companyOverall, companyBreakdown),
    [companyOverall, companyBreakdown]
  );

  const selectDriverDraft = (id) => {
    const draft = driverDrafts.find((d) => d.id === id);
    if (!draft) return;
    const parts = parseDraft(draft.report_text);
    setSelectedDriverDraftId(draft.id);
    setDriverOverall(parts.overall);
    setDriverBreakdown(parts.breakdown);
  };

  const selectCompanyDraft = (id) => {
    const draft = companyDrafts.find((d) => d.id === id);
    if (!draft) return;
    const parts = parseDraft(draft.report_text);
    setSelectedCompanyDraftId(draft.id);
    setCompanyOverall(parts.overall);
    setCompanyBreakdown(parts.breakdown);
  };

  const validateDays = (value) => {
    const dayValue = Number(value);
    if (!Number.isInteger(dayValue) || dayValue < 1 || dayValue > 30) {
      return null;
    }
    return dayValue;
  };

  const generateDriverDraft = async () => {
    const dayValue = validateDays(driverDaysBack);
    if (!dayValue) return setStatus({ type: 'error', text: 'Driver report days back must be between 1 and 30.' });
    if (!driverGroupId) return setStatus({ type: 'error', text: 'Select a driver group first.' });
    setBusy(true);
    setStatus(null);
    try {
      await api.generateAiReport({ reportType: 'driver', groupId: Number(driverGroupId), daysBack: dayValue });
      setStatus({ type: 'success', text: 'Driver report draft generated.' });
      await loadData();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const generateCompanyDraft = async () => {
    const dayValue = validateDays(companyDaysBack);
    if (!dayValue) return setStatus({ type: 'error', text: 'Company report days back must be between 1 and 30.' });
    setBusy(true);
    setStatus(null);
    try {
      await api.generateAiReport({ reportType: 'company', daysBack: dayValue });
      setStatus({ type: 'success', text: 'Company draft generated on-demand.' });
      await loadData();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const sendDriverDraft = async () => {
    if (!selectedDriverDraft) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.sendAiReport(selectedDriverDraft.id, `${driverOverall.trim()}|||${driverBreakdown.trim()}`);
      setStatus({ type: 'success', text: 'Driver report sent to management.' });
      await loadData();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const sendCompanyDraft = async () => {
    if (!selectedCompanyDraft) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.sendAiReport(selectedCompanyDraft.id, `${companyOverall.trim()}|||${companyBreakdown.trim()}`);
      setStatus({ type: 'success', text: 'Company report sent to management.' });
      await loadData();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const discardDraft = async (draft) => {
    if (!draft) return;
    if (!window.confirm('Discard this draft?')) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.discardAiReport(draft.id);
      setStatus({ type: 'success', text: 'Draft discarded.' });
      await loadData();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const reportHistoryItem = (report) => (
    <div key={report.id} className="ios-glass ai-history-item">
      <div style={{ fontWeight: 600 }}>#{report.id}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
        {new Date(report.generated_at).toLocaleString()}
      </div>
      <div style={{ fontSize: 12 }}>{report.group_name}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
        {String(report.report_text || '').slice(0, 220)}{String(report.report_text || '').length > 220 ? '...' : ''}
      </div>
    </div>
  );

  return (
    <div className="ai-features-page">
      <div className="page-header">
        <h2>✨ AI Reports</h2>
        <p>Dual-track reporting: per-driver manual workflow and company-wide automation workflow.</p>
      </div>
      {status && <div className={`alert alert-${status.type}`}>{status.text}</div>}

      <div className="ios-glass ai-tab-bar">
        <button className={`btn ${activeTab === 'driver' ? 'btn-primary' : 'btn-ghost'} touch-target`} onClick={() => setActiveTab('driver')}>
          Per Driver Report
        </button>
        <button className={`btn ${activeTab === 'company' ? 'btn-primary' : 'btn-ghost'} touch-target`} onClick={() => setActiveTab('company')}>
          Company Report
        </button>
        <button className="btn btn-ghost touch-target" onClick={loadData} disabled={busy}>Refresh</button>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading AI reports...</div>
      ) : (
        <>
          {activeTab === 'driver' && (
            <div className="ios-glass ai-section-card">
              <div className="ai-action-row">
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Driver Group</label>
                  <select className="form-input touch-target" value={driverGroupId} onChange={(e) => setDriverGroupId(e.target.value)}>
                    {driverGroups.map((g) => <option key={g.id} value={g.id}>{g.group_name}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Days Back</label>
                  <input className="form-input touch-target" style={{ width: 120 }} type="number" min="1" max="30" value={driverDaysBack} onChange={(e) => setDriverDaysBack(e.target.value)} />
                </div>
                <button className="btn btn-primary touch-target" onClick={generateDriverDraft} disabled={busy}>
                  {busy ? 'Generating...' : 'Generate Draft'}
                </button>
              </div>

              {driverDrafts.length === 0 ? (
                <div className="empty-state"><h3>No driver drafts</h3><p>Generate a per-driver draft to start editing.</p></div>
              ) : (
                <>
                  <div className="form-group" style={{ marginBottom: 10 }}>
                    <label>Select Driver Draft</label>
                    <select className="form-input touch-target" value={selectedDriverDraftId || ''} onChange={(e) => selectDriverDraft(Number(e.target.value))}>
                      {driverDrafts.map((d) => (
                        <option key={d.id} value={d.id}>
                          #{d.id} · {d.group_name} · {new Date(d.generated_at).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="ai-editor-grid">
                    <div className="ios-glass ai-editor-panel">
                      <label>Overall Summary</label>
                      <textarea className="form-textarea" value={driverOverall} onChange={(e) => setDriverOverall(e.target.value)} />
                    </div>
                    <div className="ios-glass ai-editor-panel">
                      <label>Driver Breakdown</label>
                      <textarea className="form-textarea" value={driverBreakdown} onChange={(e) => setDriverBreakdown(e.target.value)} />
                    </div>
                  </div>
                  <div className="ai-action-row" style={{ marginTop: 12 }}>
                    <button className="btn btn-primary touch-target" onClick={sendDriverDraft} disabled={busy || !selectedDriverDraft}>Approve & Send</button>
                    <button className="btn btn-danger touch-target" onClick={() => discardDraft(selectedDriverDraft)} disabled={busy || !selectedDriverDraft}>Discard</button>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'company' && (
            <div className="ios-glass ai-section-card">
              <div className="ai-action-row">
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Days Back</label>
                  <input className="form-input touch-target" style={{ width: 120 }} type="number" min="1" max="30" value={companyDaysBack} onChange={(e) => setCompanyDaysBack(e.target.value)} />
                </div>
                <button className="btn btn-primary touch-target" onClick={generateCompanyDraft} disabled={busy}>
                  {busy ? 'Generating...' : 'Generate On-Demand'}
                </button>
              </div>

              {companyDrafts.length === 0 ? (
                <div className="empty-state"><h3>No company drafts</h3><p>Automated Monday reports are sent immediately; on-demand generation creates editable drafts.</p></div>
              ) : (
                <>
                  <div className="form-group" style={{ marginBottom: 10 }}>
                    <label>Select Company Draft</label>
                    <select className="form-input touch-target" value={selectedCompanyDraftId || ''} onChange={(e) => selectCompanyDraft(Number(e.target.value))}>
                      {companyDrafts.map((d) => (
                        <option key={d.id} value={d.id}>
                          #{d.id} · {new Date(d.generated_at).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="ai-editor-grid">
                    <div className="ios-glass ai-editor-panel">
                      <label>Overall Summary</label>
                      <textarea className="form-textarea" value={companyOverall} onChange={(e) => setCompanyOverall(e.target.value)} />
                    </div>
                    <div className="ios-glass ai-editor-panel">
                      <label>Company Details / Breakdown</label>
                      <textarea className="form-textarea" value={companyBreakdown} onChange={(e) => setCompanyBreakdown(e.target.value)} />
                    </div>
                  </div>
                  <div className="form-group" style={{ marginTop: 14 }}>
                    <label>Live Preview</label>
                    <div
                      className="ai-company-html-preview"
                      style={{
                        background: 'rgba(255,255,255,0.05)',
                        padding: '14px 16px',
                        borderRadius: 12,
                        border: '1px solid rgba(255,255,255,0.08)',
                        minHeight: 80,
                        lineHeight: 1.45,
                      }}
                      dangerouslySetInnerHTML={{
                        __html: companyReportPreviewHtml || '<span style="opacity:0.45">(empty)</span>',
                      }}
                    />
                  </div>
                  <div className="ai-action-row" style={{ marginTop: 12 }}>
                    <button className="btn btn-primary touch-target" onClick={sendCompanyDraft} disabled={busy || !selectedCompanyDraft}>Approve & Send</button>
                    <button className="btn btn-danger touch-target" onClick={() => discardDraft(selectedCompanyDraft)} disabled={busy || !selectedCompanyDraft}>Discard</button>
                  </div>
                </>
              )}

              <h3 style={{ marginTop: 18, marginBottom: 10 }}>Company Report History (Sent + Automated)</h3>
              <div className="ai-history-list">
                {companyHistory.map(reportHistoryItem)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MessageManagerPage() {
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

function CompanyBirthdaysPage() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [requesting, setRequesting] = useState(false);

  // Manual Entry State
  const [newFn, setNewFn] = useState('');
  const [newLn, setNewLn] = useState('');
  const [newBd, setNewBd] = useState('');

  // Editing State
  const [editingId, setEditingId] = useState(null);
  const [editFn, setEditFn] = useState('');
  const [editLn, setEditLn] = useState('');
  const [editBd, setEditBd] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await api.getEmployeeBirthdays();
      const sorted = data.sort((a, b) => getDaysUntilBirthday(a.birthday) - getDaysUntilBirthday(b.birthday));
      setEmployees(sorted);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      setLoading(true);
      try {
        const data = await api.getEmployeeBirthdays();
        const sorted = data.sort((a, b) => getDaysUntilBirthday(a.birthday) - getDaysUntilBirthday(b.birthday));
        if (isMounted) setEmployees(sorted);
      } catch (err) {
        if (isMounted) setStatus({ type: 'error', text: err.message });
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetchData();
    return () => { isMounted = false; };
  }, []);

  const handleManualAdd = async (e) => {
    e.preventDefault();
    if (!newFn || !newLn || !newBd) return;
    setRequesting(true);
    try {
      await api.createEmployeeBirthday({ firstName: newFn, lastName: newLn, birthday: newBd });
      setNewFn(''); setNewLn(''); setNewBd('');
      setStatus({ type: 'success', text: 'Employee added successfully!' });
      loadData();
    } catch (err) { 
      setStatus({ type: 'error', text: err.message }); 
    } finally {
      setRequesting(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this employee?')) return;
    try {
      await api.deleteEmployeeBirthday(id);
      setStatus({ type: 'success', text: 'Employee deleted.' });
      loadData();
    } catch (err) { setStatus({ type: 'error', text: err.message }); }
  };

  const startEdit = (emp) => {
    setEditingId(emp.id);
    setEditFn(emp.first_name);
    setEditLn(emp.last_name);
    setEditBd(emp.birthday.split('T')[0]);
  };

  const handleUpdate = async (id) => {
    setRequesting(true);
    try {
      await api.updateEmployeeBirthday(id, { firstName: editFn, lastName: editLn, birthday: editBd });
      setEditingId(null);
      setStatus({ type: 'success', text: 'Employee updated!' });
      loadData();
    } catch (err) { 
      setStatus({ type: 'error', text: err.message }); 
    } finally {
      setRequesting(false);
    }
  };

  const handleSendRequest = async () => {
    if (!window.confirm('Send a message to the Employee Group asking for their birthdays?')) return;
    setRequesting(true);
    setStatus(null);
    try {
      await api.sendEmployeeBirthdayRequest();
      setStatus({ type: 'success', text: '✅ Request message sent to Employee Group!' });
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2>🏢 Company Employee Birthdays</h2>
          <p>Manage office staff birthdays. Bot congratulates them automatically at 9 AM CT.</p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-ghost" onClick={loadData}>🔄 Refresh</button>
          <button className="btn btn-primary" onClick={handleSendRequest} disabled={requesting}>
            {requesting ? '⏳ Requesting...' : '💬 Send Telegram Request'}
          </button>
        </div>
      </div>

      {status && <div className={`alert alert-${status.type}`} style={{ marginBottom: 20 }}>{status.text}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>➕ Manual Entry</h3>
        <form onSubmit={handleManualAdd} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
            <label>First Name</label>
            <input className="form-input" value={newFn} onChange={e => setNewFn(e.target.value)} required />
          </div>
          <div className="form-group" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
            <label>Last Name</label>
            <input className="form-input" value={newLn} onChange={e => setNewLn(e.target.value)} required />
          </div>
          <div className="form-group" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
            <label>Birthday</label>
            <input className="form-input" type="date" value={newBd} onChange={e => setNewBd(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={requesting}>
            {requesting ? '⏳ Adding...' : 'Add Employee'}
          </button>
        </form>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading...</div>
      ) : employees.length === 0 ? (
        <div className="empty-state">
          <div className="icon">🎂</div>
          <h3>No employee birthdays yet</h3>
          <p>Add them manually above or click "Send Telegram Request".</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>First Name</th>
                <th>Last Name</th>
                <th>Birthday</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {employees.map(emp => (
                <tr key={emp.id}>
                  {editingId === emp.id ? (
                    <>
                      <td><input className="form-input" value={editFn} onChange={e => setEditFn(e.target.value)} /></td>
                      <td><input className="form-input" value={editLn} onChange={e => setEditLn(e.target.value)} /></td>
                      <td><input className="form-input" type="date" value={editBd} onChange={e => setEditBd(e.target.value)} /></td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-primary btn-sm" onClick={() => handleUpdate(emp.id)} disabled={requesting} style={{ marginRight: 8 }}>
                          {requesting ? '⏳' : 'Save'}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td><strong>{emp.first_name}</strong></td>
                      <td>{emp.last_name}</td>
                      <td><span className="badge badge-active">{new Date(emp.birthday).toLocaleDateString(undefined, { timeZone: 'UTC' })}</span></td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => startEdit(emp)} style={{ marginRight: 8 }}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(emp.id)}>Delete</button>
                      </td>
                    </>
                  )}
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
    ai_features: <AiFeaturesPage />,
    scheduled: <ScheduledMessagesPage />,
    voting: <EmployeeVotingPage />,
    logs: <ChatLogsPage />,
    manager: <MessageManagerPage />,
    company_birthdays: <CompanyBirthdaysPage />,
  };

  return (
    <div className="app-layout">
      <aside className={`sidebar ${mobileMenuOpen ? 'mobile-open' : ''}`}>
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
            className={`nav-item ${page === 'ai_features' ? 'active' : ''}`}
            onClick={() => setPage('ai_features')}
          >
            <span className="nav-icon">✨</span>
            AI Features
          </button>
          <button
            className={`nav-item ${page === 'logs' ? 'active' : ''}`}
            onClick={() => setPage('logs')}
          >
            <span className="nav-icon">💬</span>
            Live Chat Logs
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
          <button
            className={`nav-item ${page === 'manager' ? 'active' : ''}`}
            onClick={() => setPage('manager')}
          >
            <span className="nav-icon">🛠️</span>
            Message Manager
          </button>
          <button
            className={`nav-item ${page === 'company_birthdays' ? 'active' : ''}`}
            onClick={() => setPage('company_birthdays')}
          >
            <span className="nav-icon">🏢</span>
            Employee Birthdays
          </button>
        </nav>
        <div className="sidebar-footer">
          <button className="logout-btn" onClick={handleLogout}>
            <span className="nav-icon">🚪</span>
            Sign Out
          </button>
        </div>
      </aside>
      <main className="main-content" onClick={() => setMobileMenuOpen(false)}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px' }}>
          <button className="mobile-menu-btn" onClick={(e) => { e.stopPropagation(); setMobileMenuOpen(!mobileMenuOpen); }}>
            ☰
          </button>
        </div>
        {pages[page]}
      </main>
    </div>
  );
}
