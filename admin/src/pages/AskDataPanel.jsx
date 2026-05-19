import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";
import { TelegramPreview, MediaUploader, MediaPositionSelector, useFormattingToolbar, getDaysUntilBirthday } from "../components/Shared";

// ───────────────────────── AI Insights v2 ─────────────────────────

export default function AskDataPanel() {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const ask = async () => {
    if (!question.trim()) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.askTheData(question.trim());
      setResult(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const suggestions = [
    'Which drivers complained about home time this month?',
    'Top 10 drivers by negative sentiment in the last 14 days',
    'How many quit signals this month, by group?',
    'Which dispatcher messages went unanswered in the last 7 days?',
    'Show me every breakdown or accident mention this week',
  ];

  return (
    <div className="ios-glass ai-section-card" style={{ marginTop: 18 }}>
      <h3 style={{ marginTop: 0 }}>💬 Ask the Data</h3>
      <p style={{ fontSize: 13, opacity: 0.75, marginTop: 0 }}>
        Ask anything about driver conversations. Powered by Groq + annotated chat logs.
      </p>
      <div className="ai-action-row">
        <input
          className="form-input touch-target"
          style={{ flex: 1 }}
          placeholder="Ask a question…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) ask(); }}
        />
        <button className="btn btn-primary touch-target" onClick={ask} disabled={busy || !question.trim()}>
          {busy ? 'Thinking…' : 'Ask'}
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {suggestions.map((s) => (
          <button
            key={s}
            className="btn btn-ghost btn-sm"
            onClick={() => { setQuestion(s); }}
            disabled={busy}
            style={{ fontSize: 12 }}
          >
            {s}
          </button>
        ))}
      </div>

      {error && <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}

      {result && (
        <div style={{ marginTop: 12 }}>
          <div className="ios-glass" style={{ padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>Answer</div>
            <div dangerouslySetInnerHTML={{ __html: result.answer_html || '<i>(no narrative)</i>' }} />
          </div>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 13, opacity: 0.75 }}>
              Query plan · {result.row_count} rows returned
            </summary>
            <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.25)', padding: 8, borderRadius: 6, marginTop: 6 }}>
              {JSON.stringify(result.plan, null, 2)}
            </pre>
            <div style={{ fontSize: 11, marginTop: 6, opacity: 0.7 }}>SQL:</div>
            <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.25)', padding: 8, borderRadius: 6 }}>
              {result.sql}
            </pre>
          </details>
          {result.rows && result.rows.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, opacity: 0.75 }}>
                Results ({result.rows.length})
              </summary>
              <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 6, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6 }}>
                <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {Object.keys(result.rows[0]).slice(0, 8).map((k) => (
                        <th key={k} style={{ textAlign: 'left', padding: 6, borderBottom: '1px solid rgba(255,255,255,0.08)', position: 'sticky', top: 0, background: 'rgba(0,0,0,0.3)' }}>
                          {k}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.slice(0, 50).map((r, i) => (
                      <tr key={i}>
                        {Object.keys(result.rows[0]).slice(0, 8).map((k) => (
                          <td key={k} style={{ padding: 6, borderBottom: '1px solid rgba(255,255,255,0.05)', verticalAlign: 'top', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {typeof r[k] === 'object' ? JSON.stringify(r[k]) : String(r[k] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
