import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";
import { TelegramPreview, MediaUploader, MediaPositionSelector, useFormattingToolbar, getDaysUntilBirthday } from "../components/Shared";

export default function EmployeeVotingPage() {
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
