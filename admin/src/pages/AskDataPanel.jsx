import React, { useState } from "react";
import * as api from "../api";
import { humanizeColumn } from "../utils/formatTime";

const QUICK_QUERIES = [
  {
    icon: '📋',
    label: 'Drivers who responded this week',
    question: 'Which drivers responded to surveys this week?',
  },
  {
    icon: '📊',
    label: 'Negative sentiment trends',
    question: 'Top 10 drivers by negative sentiment in the last 14 days',
  },
  {
    icon: '🚨',
    label: 'Quit signals this month',
    question: 'How many quit signals this month, by group?',
  },
  {
    icon: '💬',
    label: 'Unanswered dispatcher messages',
    question: 'Which dispatcher messages went unanswered in the last 7 days?',
  },
  {
    icon: '⚠️',
    label: 'Breakdowns & accidents',
    question: 'Show me every breakdown or accident mention this week',
  },
];

export default function AskDataPanel() {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);

  const ask = async (q) => {
    const query = (q || question).trim();
    if (!query) return;
    setQuestion(query);
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.askTheData(query);
      setResult(r);
      setHistory(prev => {
        const next = [query, ...prev.filter(h => h !== query)];
        return next.slice(0, 5);
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const humanizeError = (msg) => {
    if (!msg) return 'Something went wrong. Please try again.';
    if (msg.includes('syntax') || msg.includes('SQL'))
      return "Sorry, I couldn't understand that question. Try rephrasing it in simpler terms.";
    if (msg.includes('timeout'))
      return 'The query took too long. Try asking something more specific.';
    if (msg.includes('401') || msg.includes('403'))
      return 'You don\'t have permission to run this query. Please contact your admin.';
    return msg;
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>🔍 Ask a Question</h2>
          <p>Ask anything about your drivers, messages, or leads in plain English.</p>
        </div>
      </div>

      {/* Quick Query Cards */}
      <div className="quick-query-grid">
        {QUICK_QUERIES.map((q, i) => (
          <button
            key={i}
            className="quick-query-card"
            onClick={() => ask(q.question)}
            disabled={busy}
          >
            <span className="quick-query-icon">{q.icon}</span>
            <span className="quick-query-label">{q.label}</span>
          </button>
        ))}
      </div>

      {/* Search input */}
      <div className="ai-action-row" style={{ marginBottom: 16 }}>
        <input
          className="form-input touch-target"
          style={{ flex: 1 }}
          placeholder="Or type your own question…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) ask(); }}
        />
        <button className="btn btn-primary touch-target" onClick={() => ask()} disabled={busy || !question.trim()}>
          {busy ? '⏳ Thinking…' : '🔍 Ask'}
        </button>
      </div>

      {/* Recent queries */}
      {history.length > 0 && !busy && !result && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
            Recent questions
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {history.map((h, i) => (
              <button
                key={i}
                className="btn btn-ghost btn-sm"
                onClick={() => ask(h)}
                style={{ fontSize: 12 }}
              >
                {h.length > 60 ? h.slice(0, 60) + '…' : h}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="alert alert-error" style={{ marginTop: 0 }}>
          ⚠️ {humanizeError(error)}
        </div>
      )}

      {/* Results */}
      {result && (
        <div style={{ marginTop: 0 }}>
          {/* Answer card */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
              Answer
            </div>
            <div
              style={{ fontSize: 15, lineHeight: 1.6 }}
              dangerouslySetInnerHTML={{ __html: result.answer_html || '<i style="color: var(--text-muted)">(No answer generated)</i>' }}
            />
          </div>

          {/* Results table with humanized column names */}
          {result.rows && result.rows.length > 0 && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  📊 {result.rows.length} result{result.rows.length !== 1 ? 's' : ''} found
                </span>
              </div>
              <div style={{ maxHeight: 400, overflow: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {Object.keys(result.rows[0]).slice(0, 8).map((k) => (
                        <th key={k} style={{ textAlign: 'left', padding: '10px 16px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg-secondary)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', fontWeight: 600 }}>
                          {humanizeColumn(k)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.slice(0, 50).map((r, i) => (
                      <tr key={i}>
                        {Object.keys(result.rows[0]).slice(0, 8).map((k) => (
                          <td key={k} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {typeof r[k] === 'object' ? JSON.stringify(r[k]) : String(r[k] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.rows.length > 50 && (
                <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
                  Showing first 50 of {result.rows.length} results
                </div>
              )}
            </div>
          )}

          {/* Technical details — hidden by default */}
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
              🔧 Show technical details
            </summary>
            <div className="card" style={{ marginTop: 8, padding: 16 }}>
              {result.plan && (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', fontWeight: 600 }}>Query Plan</div>
                  <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.25)', padding: 8, borderRadius: 6, marginBottom: 12, color: 'var(--text-secondary)' }}>
                    {JSON.stringify(result.plan, null, 2)}
                  </pre>
                </>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', fontWeight: 600 }}>SQL Query</div>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.25)', padding: 8, borderRadius: 6, color: 'var(--text-secondary)' }}>
                {result.sql}
              </pre>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                {result.row_count} rows returned
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

