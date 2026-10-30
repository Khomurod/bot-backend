import React, { useCallback, useEffect, useState } from "react";

import * as api from "../../api";
import NewSurveyForm from "./surveys/NewSurveyForm";
import SurveyCard from "./surveys/SurveyCard";

/**
 * Messages → Surveys: multiple-choice questions to driver groups.
 *
 * Until the October 2026 audit this tab could only READ surveys — the server
 * could create, send and close one (`server/routes/questionsRoutes.js`) but no
 * screen called it. Now: New survey writes one (saving does not send), each
 * card sends it to the active driver groups after a confirmation, or closes it.
 */
export default function SurveysTab() {
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getQuestions();
      setQuestions(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      setError(err?.message || "Could not load the surveys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const open = questions.filter((q) => q.active !== false).length;
  const answers = questions.reduce((sum, q) => sum + (Number(q.response_count) || 0), 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 16 }}>
        <p style={{ color: "var(--text-secondary)", fontSize: 14, margin: 0, maxWidth: 640 }}>
          Multiple-choice questions to driver groups, each in its own language. A driver answers by tapping
          a button, once; every answer is also relayed to the management group.
        </p>
        {!creating && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { setStatus(null); setCreating(true); }}>New survey</button>
        )}
      </div>

      {status && <div className="alert alert-success" role="status" style={{ marginBottom: 12 }}>{status}</div>}
      {creating && (
        <NewSurveyForm
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            setStatus("Survey saved. It has not been sent yet — use Send on its card when it is ready.");
            load();
          }}
        />
      )}

      {!loading && !error && questions.length > 0 && (
        <div className="stats-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 24 }}>
          <div className="stat-card"><div className="stat-value">{questions.length}</div><div className="stat-label">Surveys</div></div>
          <div className="stat-card"><div className="stat-value">{open}</div><div className="stat-label">Open</div></div>
          <div className="stat-card"><div className="stat-value">{answers}</div><div className="stat-label">Answers</div></div>
        </div>
      )}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading surveys…</div>
      ) : error ? (
        <div className="alert alert-error">
          {error}{" "}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); load(); }}>Try again</button>
        </div>
      ) : questions.length === 0 ? (
        <div className="empty-state">
          <h3>No surveys yet</h3>
          <p>Use New survey to write the first one.</p>
        </div>
      ) : (
        <div className="questions-list">
          {questions.map((q) => (
            <SurveyCard
              key={q.id} question={q} expanded={expanded === q.id}
              onToggle={() => setExpanded((cur) => (cur === q.id ? null : q.id))}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}
