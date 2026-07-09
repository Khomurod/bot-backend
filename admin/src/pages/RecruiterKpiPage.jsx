import React, { useCallback, useEffect, useState } from "react";
import * as api from "../api";

/**
 * Recruiter KPI dashboard — per-recruiter daily call performance vs targets.
 *
 * Main KPI: 2h 30m of REAL call duration per day (calls under the 30-second
 * threshold do not count toward it). Secondary KPI: 150 outbound calls/day.
 * The score is 70% talk-time progress + 30% outbound progress. All numbers
 * are derived from the RingCentral call log.
 */

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDuration(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function Bar({ value, target, color, pct }) {
  const width = pct != null ? pct : (target ? Math.min(100, Math.round((value / target) * 100)) : 0);
  return (
    <div style={{ height: 8, borderRadius: 6, background: "rgba(148,163,184,0.18)", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${width}%`, background: color, borderRadius: 6, transition: "width .3s" }} />
    </div>
  );
}

function KpiRow({ label, value, target, unit, color, pct, met }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
        <span style={{ fontSize: 13, color: "#cbd5e1" }}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: met ? "#22c55e" : "#e2e8f0" }}>
          {value}{unit || ""}{target != null ? <span style={{ color: "#64748b", fontWeight: 400 }}> / {target}</span> : null}
        </span>
      </div>
      <Bar value={value} target={target} color={color} pct={pct} />
    </div>
  );
}

const COLORS = { talk: "#a78bfa", outbound: "#22d3ee", real: "#4ade80", strong: "#f59e0b" };

export default function RecruiterKpiPage() {
  const [date, setDate] = useState(todayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async (d) => {
    setLoading(true); setMessage(null);
    try { setData(await api.getRecruiterStats(d)); }
    catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(date); }, [load, date]);

  const sync = async () => {
    setSyncing(true); setMessage(null);
    try {
      const res = await api.syncRecruiterCalls(false);
      if (res.skipped) setMessage({ type: "error", text: `Sync skipped: ${res.skipped === "disabled" ? "monitoring is disabled in Settings" : "RingCentral credentials not configured"}.` });
      else setMessage({ type: "success", text: `Synced ${res.synced} call(s), ${res.attributed} attributed to recruiters.` });
      await load(date);
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setSyncing(false); }
  };

  const targets = data?.targets || { talkSeconds: 9000, talkLabel: "2h 30m", outbound: 150, realConversations: 35 };
  const shortThreshold = data?.thresholds?.nonValuableMaxSeconds ?? 30;
  const recruiters = data?.recruiters || [];

  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2>📞 Recruiter Call KPIs</h2>
          <p>Daily call performance vs targets, from the RingCentral call log.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input className="form-input" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 170 }} />
          <button className="btn btn-ghost btn-sm" onClick={sync} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>
        </div>
      </div>

      {message && <div className={`alert alert-${message.type === "error" ? "error" : "success"}`}>{message.text}</div>}

      {/* KPI rules reference */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0, textAlign: "center", letterSpacing: 1 }}>DAILY RECRUITER TARGETS</h3>
        <p style={{ textAlign: "center", color: "#94a3b8", marginTop: -6 }}>
          Main KPI: <strong style={{ color: "#e2e8f0" }}>{targets.talkLabel} real call duration</strong> ·
          Secondary KPI: <strong style={{ color: "#e2e8f0" }}>{targets.outbound} outbound calls</strong>
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
          <span className="badge badge-inactive">&lt; {shortThreshold}s : does NOT count toward talk time</span>
          <span className="badge badge-muted">&gt; {data?.thresholds?.realConversationMinSeconds ?? 60}s : Real Conversation</span>
          <span className="badge" style={{ background: "rgba(167,139,250,0.2)", color: "#c4b5fd" }}>&gt; {data?.thresholds?.strongConversationMinSeconds ?? 180}s : Strong Conv.</span>
        </div>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading…</div>
      ) : recruiters.length === 0 ? (
        <div className="card"><p style={{ color: "#94a3b8", margin: 0 }}>No active recruiters. Add recruiters and their RingCentral numbers in <strong>Settings → RingCentral</strong>.</p></div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
          {recruiters.map((r) => (
            <div className="card" key={r.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                <h3 style={{ margin: 0 }}>{r.name}</h3>
                <span style={{ fontSize: 22, fontWeight: 800, color: r.mainScore >= 100 ? "#22c55e" : r.mainScore >= 50 ? "#f59e0b" : "#f87171" }}>{r.mainScore}%</span>
              </div>
              <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", marginBottom: 14 }}>{r.phoneNumber} · Daily Call Duration Score</div>

              <KpiRow
                label={`Real Call Duration (≥${shortThreshold}s calls)`}
                value={fmtDuration(r.valuableTalkSeconds)}
                target={targets.talkLabel}
                color={COLORS.talk}
                pct={r.talkPct}
                met={r.talkMet}
              />
              <KpiRow label="Outbound Calls" value={r.outbound} target={targets.outbound} color={COLORS.outbound} pct={r.outboundPct} met={r.outboundMet} />
              <KpiRow label="Real Conversations (>1 min)" value={r.realConversations} target={targets.realConversations} color={COLORS.real} pct={r.realConversationsPct} met={r.realConversationsMet} />
              <KpiRow label="Strong Conversations (>3 min)" value={r.strongConversations} target={null} color={COLORS.strong} pct={targets.realConversations ? Math.min(100, Math.round((r.strongConversations / targets.realConversations) * 100)) : 0} />

              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, fontSize: 12, color: "#94a3b8", marginTop: 10, borderTop: "1px solid rgba(148,163,184,0.15)", paddingTop: 10 }}>
                <span>Inbound: <strong style={{ color: "#cbd5e1" }}>{r.inbound}</strong></span>
                <span title={`Calls under ${shortThreshold}s — excluded from talk time`}>Short calls: <strong style={{ color: "#cbd5e1" }}>{r.nonValuableCalls}</strong></span>
                <span>Raw talk: <strong style={{ color: "#cbd5e1" }}>{fmtDuration(r.totalTalkSeconds)}</strong></span>
                <span>To target: <strong style={{ color: "#cbd5e1" }}>{r.talkMet ? "✓ met" : fmtDuration(r.talkRemainingSeconds)}</strong></span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
