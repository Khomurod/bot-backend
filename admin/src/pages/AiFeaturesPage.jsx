import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";
import { TelegramPreview, MediaUploader, MediaPositionSelector, useFormattingToolbar, getDaysUntilBirthday } from "../components/Shared";

function buildCompanyReportPreviewHtml(overall, breakdown) {
  const toPreview = (html) =>
    sanitizeCompanyReportHtmlForTelegram(html).replace(/\n/g, '<br/>');
  const o = toPreview(overall);
  const b = toPreview(breakdown);
  if (!o && !b) return '';
  if (!o) return b;
  if (!b) return o;
  return `${o}<br/><br/>${b}`;
}

export default function AiFeaturesPage() {
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
        <h2>🧠 AI Insights</h2>
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
