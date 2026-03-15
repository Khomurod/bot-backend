import React, { useState, useEffect, useCallback } from 'react';
import * as api from './api';

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

      await api.createQuestion({ translations, options: opts });
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
      await api.sendTestQuestion(questionEn.trim(), enOptions);
      onError(null);
      // Show success via parent
      onCreated.__testSuccess?.() ||
        alert('✅ Test question sent to management group!');
    } catch (err) {
      onError(err.message);
    } finally {
      setSendingTest(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: 32 }}>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>📝 Question Translations</h3>
        <div className="translations-grid">
          <div className="lang-section">
            <h4><span className="badge badge-en">EN</span> English</h4>
            <textarea
              className="form-textarea"
              value={questionEn}
              onChange={(e) => setQuestionEn(e.target.value)}
              placeholder="Question in English"
              required
            />
          </div>
          <div className="lang-section">
            <h4><span className="badge badge-ru">RU</span> Russian</h4>
            <textarea
              className="form-textarea"
              value={questionRu}
              onChange={(e) => setQuestionRu(e.target.value)}
              placeholder="Вопрос на русском"
              required
            />
          </div>
          <div className="lang-section">
            <h4><span className="badge badge-uz">UZ</span> Uzbek</h4>
            <textarea
              className="form-textarea"
              value={questionUz}
              onChange={(e) => setQuestionUz(e.target.value)}
              placeholder="Savol o'zbek tilida"
              required
            />
          </div>
        </div>
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
