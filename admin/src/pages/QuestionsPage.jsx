import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";
import { TelegramPreview, MediaUploader, MediaPositionSelector, useFormattingToolbar, getDaysUntilBirthday } from "../components/Shared";

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
