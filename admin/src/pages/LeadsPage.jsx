import React, { useState, useEffect, useCallback } from "react";
import * as api from "../api";
import { timeAgo } from "../utils/formatTime";

const SOURCE_BADGE = {
  facebook: { label: "Facebook", bg: "#1877F2" },
  indeed: { label: "Indeed", bg: "#2557a7" },
};

const STATUS_BADGE = {
  created: { label: "In Bitrix24", bg: "#16a34a" },
  pending: { label: "Pending", bg: "#64748b" },
  skipped: { label: "Skipped", bg: "#64748b" },
  disabled: { label: "Bitrix off", bg: "#a16207" },
  failed: { label: "Failed", bg: "#dc2626" },
};

function Badge({ map, value }) {
  const cfg = map[value] || { label: value || "—", bg: "#64748b" };
  return (
    <span style={{
      background: cfg.bg, color: "#fff", borderRadius: 6, padding: "2px 8px",
      fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
    }}>{cfg.label}</span>
  );
}

const APPS_SCRIPT = `// === Wenze Indeed → Bitrix24 forwarder ===
// 1) Paste your two values below.
var ENDPOINT = 'https://bot-backend-x9lc.onrender.com/api/internal/indeed/lead';
var SECRET   = 'PASTE_YOUR_LEADS_INTERNAL_SHARED_SECRET_HERE';

function pollIndeed() {
  // New, unread Indeed emails from the last 2 days.
  var threads = GmailApp.search('from:(indeed.com) is:unread newer_than:2d');
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      if (!m.isUnread()) continue;

      // Attach the résumé PDF if Indeed included one (gives the real phone).
      var resume = '';
      var atts = m.getAttachments();
      for (var k = 0; k < atts.length; k++) {
        var name = (atts[k].getName() || '').toLowerCase();
        if (name.indexOf('.pdf') !== -1 && atts[k].getSize() < 8000000) {
          resume = Utilities.base64Encode(atts[k].getBytes());
          break;
        }
      }

      UrlFetchApp.fetch(ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-internal-shared-secret': SECRET },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          messageId: m.getId(),
          from: m.getFrom(),
          subject: m.getSubject(),
          body: m.getPlainBody(),
          resumePdfBase64: resume
        })
      });
      m.markRead();
    }
  }
}`;

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchData = useCallback(async (isMounted = { current: true }) => {
    try {
      const data = await api.getLeads(source);
      if (isMounted.current) { setLeads(Array.isArray(data) ? data : []); setError(null); }
    } catch (err) {
      if (isMounted.current) setError(err.message);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    const mounted = { current: true };
    setLoading(true);
    fetchData(mounted);
    const interval = setInterval(() => fetchData(mounted), 15000);
    return () => { mounted.current = false; clearInterval(interval); };
  }, [fetchData]);

  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(APPS_SCRIPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div>
      <div className="page-header">
        <h2>📥 Leads</h2>
        <p>All incoming leads from Facebook and Indeed · Auto-refreshes every 15s</p>
      </div>

      {/* ── Gmail script instructions ── */}
      <div className="glass-card" style={{ marginBottom: 20, padding: 16 }}>
        <button
          className="btn btn-ghost"
          onClick={() => setShowGuide((v) => !v)}
          style={{ width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between" }}
        >
          <span>📧 How to connect Indeed (Gmail script) — one-time setup per recruiter inbox</span>
          <span>{showGuide ? "▾" : "▸"}</span>
        </button>

        {showGuide && (
          <div style={{ marginTop: 12, lineHeight: 1.6 }}>
            <ol style={{ paddingLeft: 18 }}>
              <li>In the recruiter's Indeed account, turn on <strong>“Email me the candidate's résumé as an attachment”</strong> in the job's alert settings (this is what gives us the real phone number).</li>
              <li>Open <a href="https://script.google.com" target="_blank" rel="noreferrer">script.google.com</a> while signed in to that recruiter's Gmail and click <strong>New project</strong>.</li>
              <li>Delete the sample code, then paste the script below.</li>
              <li>Replace <code>PASTE_YOUR_LEADS_INTERNAL_SHARED_SECRET_HERE</code> with your internal secret (the value of <code>LEADS_INTERNAL_SHARED_SECRET</code>).</li>
              <li>Click <strong>Save</strong>, then run <code>pollIndeed</code> once and click <strong>Allow</strong> when Google asks for permission.</li>
              <li>On the left, open <strong>Triggers</strong> (⏰) → <strong>Add Trigger</strong> → function <code>pollIndeed</code>, event source <strong>Time-driven</strong>, <strong>Minutes timer → every 5 minutes</strong>. Save.</li>
              <li>Done. New Indeed applications will appear in this table within ~5 minutes and sync to Bitrix24.</li>
            </ol>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
              <button className="btn btn-ghost" onClick={copyScript}>{copied ? "✓ Copied" : "Copy script"}</button>
            </div>
            <pre style={{
              background: "#0b1220", color: "#cbd5e1", padding: 12, borderRadius: 8,
              overflowX: "auto", fontSize: 12, maxHeight: 320,
            }}>{APPS_SCRIPT}</pre>
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Note: Indeed hides the applicant's email/phone until they reply, so contact details come from the résumé when available — you'll usually get a real phone, sometimes only the name.
            </p>
          </div>
        )}
      </div>

      {/* ── Source filter ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {[["", "All"], ["facebook", "Facebook"], ["indeed", "Indeed"]].map(([val, label]) => (
          <button
            key={val || "all"}
            className={`btn ${source === val ? "" : "btn-ghost"}`}
            onClick={() => setSource(val)}
          >{label}</button>
        ))}
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading leads…</div>
      ) : error ? (
        <div className="alert alert-error">⚠️ {error}</div>
      ) : leads.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📥</div>
          <h3>No leads yet</h3>
          <p>Facebook and Indeed leads will appear here as they arrive.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Source</th>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Job / Note</th>
                <th>Bitrix24</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id}>
                  <td style={{ whiteSpace: "nowrap", fontSize: 12, color: "var(--text-muted)" }}>{timeAgo(lead.created_at)}</td>
                  <td><Badge map={SOURCE_BADGE} value={lead.source} /></td>
                  <td><strong>{lead.full_name || "—"}</strong></td>
                  <td style={{ whiteSpace: "nowrap" }}>{lead.phone || "—"}</td>
                  <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{lead.email || "—"}</td>
                  <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>{lead.job_title || lead.message || "—"}</td>
                  <td><Badge map={STATUS_BADGE} value={lead.bitrix_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
