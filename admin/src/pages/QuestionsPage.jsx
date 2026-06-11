import React, { useState, useEffect, useCallback } from "react";
import * as api from "../api";
import { timeAgo } from "../utils/formatTime";

export default function QuestionsPage() {
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

  const getQuestionText = (question) => {
    if (question.text_en) return question.text_en;
    if (!Array.isArray(question.translations)) return "(no survey text)";
    const en = question.translations.find((t) => t && t.language === "en");
    const fallback = question.translations.find((t) => t && typeof t.question_text === "string");
    return (en && en.question_text) || (fallback && fallback.question_text) || "(no survey text)";
  };

  const totalResponses = questions.reduce((sum, q) => sum + (responses[q.id]?.length || 0), 0);

  return (
    <div>
      <div className="page-header">
        <h2>📝 Surveys</h2>
        <p>Create and manage driver feedback surveys.</p>
      </div>

      {!loading && !error && questions.length > 0 && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-value">{questions.length}</div>
            <div className="stat-label">Total Surveys</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{totalResponses}</div>
            <div className="stat-label">Responses Loaded</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading surveys...</div>
      ) : error ? (
        <div className="alert alert-error">⚠️ {error}</div>
      ) : questions.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📝</div>
          <h3>No surveys yet</h3>
          <p>Surveys will appear here once they are created by the bot.</p>
        </div>
      ) : (
        <div className="questions-list">
          {questions.map(q => (
            <div key={q.id} className="card question-card" style={{ marginBottom: 12 }}>
              <div className="question-header" onClick={() => toggleQuestion(q.id)} style={{ cursor: 'pointer' }}>
                <div className="question-info">
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{timeAgo(q.created_at)}</span>
                  <h3 style={{ margin: '4px 0 0' }}>{getQuestionText(q)}</h3>
                </div>
                <div className="question-stats" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className={`status-pill ${(responses[q.id]?.length || 0) > 0 ? 'status-pill--success' : 'status-pill--neutral'}`}>
                    {responses[q.id]?.length || 0} {(responses[q.id]?.length || 0) === 1 ? 'response' : 'responses'}
                  </span>
                  <span className="expand-icon" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{expanded === q.id ? '▲' : '▼'}</span>
                </div>
              </div>

              {expanded === q.id && (
                <div className="responses-container" style={{ marginTop: 16 }}>
                  {!responses[q.id] ? (
                    <div className="loading" style={{ padding: 20 }}><div className="spinner"></div> Loading responses...</div>
                  ) : responses[q.id].length === 0 ? (
                    <div className="empty-state" style={{ padding: 32 }}>
                      <div className="icon">💬</div>
                      <h3>No responses yet</h3>
                      <p>Driver responses will appear here once they reply to this survey.</p>
                    </div>
                  ) : (
                    <div className="table-container">
                      <table>
                        <thead>
                          <tr>
                            <th>Driver</th>
                            <th>Group</th>
                            <th>Response</th>
                            <th>Submitted</th>
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
                              <td style={{ whiteSpace: 'nowrap' }}>{timeAgo(r.created_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
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
