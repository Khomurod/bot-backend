import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import useVisibleInterval from "../utils/useVisibleInterval";

/**
 * /recruiters — public, full-screen, gamified leaderboard.
 *
 * Meant to live on a wall screen or a recruiter's second monitor. The MAIN KPI
 * is real call duration: 2h 30m of talk time per recruiter per day, where
 * calls shorter than the configured threshold (30 seconds by default) do NOT
 * count. The secondary KPI is 150 outbound calls/day. Recruiters rank by the
 * main score (70% talk-time progress + 30% outbound progress).
 *
 * Views: today (live, auto-refreshes every minute), one historical day, or an
 * inclusive date range (targets scale by the number of days).
 *
 * Metric colors are palette-validated for the dark surface (lightness band,
 * CVD separation, contrast): purple #7c3aed talk time · cyan #0891b2 outbound
 * · green #16a34a real conv · amber #d97706 strong. Every meter is
 * direct-labeled, and rank/status always carry an icon + text, never color
 * alone.
 */

const COLORS = {
  talk: "#7c3aed",
  outbound: "#0891b2",
  real: "#16a34a",
  strong: "#d97706",
  ink: "#e2e8f0",
  inkSoft: "#94a3b8",
  inkMuted: "#64748b",
  surface: "#0f172a",
  card: "rgba(30, 41, 59, 0.75)",
  good: "#16a34a",
  warn: "#d97706",
};

const REFRESH_MS = 60_000;
// Day-pace window: the fraction of the 8:00–18:00 workday that has elapsed.
const WORKDAY_START_H = 8;
const WORKDAY_END_H = 18;

const CHEERS = [
  "Main KPI: 2.5h of real call duration. Own the phone! 🗣️",
  "Calls under 30 seconds don't count — get past the first half minute!",
  "Every real minute of talk time moves you up the board. ⏱️",
  "Secondary KPI: 150 outbound calls. The phone won't dial itself!",
  "Strong conversations build strong fleets. 3 minutes or more! 💪",
  "Somebody's next great driver is one call away. Find them!",
];

function dayPaceFraction(now = new Date()) {
  const h = now.getHours() + now.getMinutes() / 60;
  return Math.max(0, Math.min(1, (h - WORKDAY_START_H) / (WORKDAY_END_H - WORKDAY_START_H)));
}

function useCountUp(target, duration = 900) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target) || 0;
    if (from === to) { setDisplay(to); return undefined; }
    const startTs = performance.now();
    let raf;
    const step = (ts) => {
      const t = Math.min(1, (ts - startTs) / duration);
      const eased = 1 - (1 - t) ** 3;
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return display;
}

function fmtTalk(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Animated horizontal meter with a direct value/target label + day-pace tick. */
function Meter({ label, value, target, color, mounted, pace, fmt }) {
  const shown = useCountUp(value);
  const pct = target ? Math.min(100, (value / target) * 100) : 0;
  const met = target != null && value >= target;
  const show = (v) => (fmt ? fmt(v) : v);
  return (
    <div style={{ marginBottom: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
        <span style={{ fontSize: 13, color: COLORS.inkSoft }}>{label}</span>
        <span style={{ fontSize: 15, fontWeight: 800, color: met ? COLORS.good : COLORS.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {met ? "✓ " : ""}{show(shown)}
          {target != null && <span style={{ color: COLORS.inkMuted, fontWeight: 500 }}> / {show(target)}</span>}
        </span>
      </div>
      <div style={{ position: "relative", height: 10, borderRadius: 6, background: "rgba(148,163,184,0.16)", overflow: "hidden" }}>
        <div
          className="rlb-bar"
          style={{
            height: "100%",
            width: mounted ? `${pct}%` : "0%",
            background: color,
            borderRadius: 6,
          }}
        />
        {pace != null && pace > 0 && pace < 1 && (
          <div
            title="Where you should be by now"
            style={{ position: "absolute", top: -2, bottom: -2, left: `${pace * 100}%`, width: 2, background: "rgba(226,232,240,0.65)", borderRadius: 1 }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Main ring gauge: real (valuable) talk time vs the 2h 30m target.
 * Calls under the 30-second threshold are already excluded server-side.
 */
function TalkRing({ seconds, targetSeconds, targetLabel, mounted, size = 124 }) {
  const shown = useCountUp(seconds);
  const r = (size - 16) / 2;
  const C = 2 * Math.PI * r;
  const pct = targetSeconds ? Math.min(100, Math.max(0, (seconds / targetSeconds) * 100)) : 0;
  const met = targetSeconds != null && seconds >= targetSeconds;
  return (
    <svg width={size} height={size} role="img" aria-label={`Real call duration ${fmtTalk(seconds)} of ${targetLabel}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(148,163,184,0.16)" strokeWidth="11" />
      <circle
        className="rlb-ring"
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={met ? COLORS.good : COLORS.talk}
        strokeWidth="11" strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={mounted ? C * (1 - pct / 100) : C}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="43%" textAnchor="middle" fill={met ? COLORS.good : COLORS.ink} fontSize="21" fontWeight="800" fontFamily="inherit">
        {fmtTalk(shown)}
      </text>
      <text x="50%" y="58%" textAnchor="middle" fill={COLORS.inkMuted} fontSize="11" fontFamily="inherit">
        of {targetLabel}
      </text>
      <text x="50%" y="72%" textAnchor="middle" fill={COLORS.inkMuted} fontSize="9" letterSpacing="1" fontFamily="inherit">
        REAL TALK TIME
      </text>
    </svg>
  );
}

/**
 * Status priority: crushed → on pace → far behind → whichever KPI lags most.
 * `expectedPct` is the day-pace expectation (100 for historical views).
 */
function statusFor(r, expectedPct) {
  if (r.talkMet && r.outboundMet) {
    return { icon: "🏆", text: "TARGET CRUSHED", color: COLORS.good, crushed: true };
  }
  const talkGap = expectedPct - (r.talkPct || 0);
  const outGap = expectedPct - (r.outboundPct || 0);
  if (talkGap <= 5 && outGap <= 5) return { icon: "🔥", text: "ON PACE", color: COLORS.ink, crushed: false };
  if (talkGap > 35 && outGap > 35) return { icon: "🚨", text: "PICK UP THE PACE", color: COLORS.warn, crushed: false };
  if (talkGap >= outGap) return { icon: "⚡", text: "NEED MORE TALK TIME", color: COLORS.warn, crushed: false };
  return { icon: "📞", text: "KEEP DIALING", color: COLORS.warn, crushed: false };
}

/** Personalized one-line coaching message for a recruiter card. */
function coachLine(r, targets) {
  if (r.talkMet && r.outboundMet) return "Legendary day — keep the momentum going! 🏆";
  if (r.talkMet && !r.outboundMet) {
    return `Great call time — now push outbound to ${targets.outbound}! 📞`;
  }
  if ((r.nonValuableCalls || 0) >= 8 && (r.nonValuableCalls || 0) > (r.realConversations || 0)) {
    return "Too many short calls — keep drivers engaged longer! ⏱️";
  }
  const remaining = fmtTalk(r.talkRemainingSeconds);
  if ((r.talkPct || 0) >= 75) return `Final stretch — ${remaining} left to hit ${targets.talkLabel}! 🚀`;
  if ((r.talkPct || 0) >= 50) return `Halfway there! ${remaining} left to hit ${targets.talkLabel} 💪`;
  return `${remaining} left to hit ${targets.talkLabel}`;
}

const MEDALS = ["🥇", "🥈", "🥉"];

function RecruiterCard({ r, rank, targets, pace, live, mounted, shortThreshold }) {
  const expectedPct = (live ? pace : 1) * 100;
  const status = statusFor(r, expectedPct);
  const isLeader = rank === 0 && (r.valuableTalkSeconds > 0 || r.outbound > 0);
  return (
    <div
      className={`rlb-card ${status.crushed ? "rlb-crushed" : ""} ${isLeader ? "rlb-leader" : ""}`}
      style={{
        position: "relative",
        background: COLORS.card,
        border: `1px solid ${status.crushed ? "rgba(22,163,74,0.55)" : isLeader ? "rgba(124,58,237,0.55)" : "rgba(148,163,184,0.16)"}`,
        borderRadius: 16,
        padding: "18px 20px",
        overflow: "hidden",
        animationDelay: `${rank * 90}ms`,
      }}
    >
      {status.crushed && (
        <div className="rlb-confetti" aria-hidden="true">
          {["🎉", "⭐", "🎊", "✨", "🏆"].map((e, idx) => (
            <span key={idx} style={{ left: `${12 + idx * 18}%`, animationDelay: `${idx * 0.7}s` }}>{e}</span>
          ))}
        </div>
      )}

      <div style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 26 }} aria-label={`rank ${rank + 1}`}>{MEDALS[rank] || `#${rank + 1}`}</span>
          <span style={{ fontSize: 19, fontWeight: 800, color: COLORS.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {r.name}
          </span>
        </div>
        <span
          className={status.crushed ? "rlb-pulse" : ""}
          style={{
            fontSize: 12, fontWeight: 800, letterSpacing: 1, whiteSpace: "nowrap",
            color: status.color, border: `1px solid ${status.color}55`,
            background: `${status.color}1a`, borderRadius: 999, padding: "4px 10px",
          }}
        >
          {status.icon} {status.text}
        </span>
      </div>

      <div style={{ position: "relative", zIndex: 1, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ textAlign: "center" }}>
          <TalkRing
            seconds={r.valuableTalkSeconds}
            targetSeconds={targets.talkSeconds}
            targetLabel={targets.talkLabel}
            mounted={mounted}
          />
          <div style={{ fontSize: 11, color: COLORS.inkMuted, marginTop: 2 }}>
            Talk Time Score: <strong style={{ color: COLORS.ink }}>{r.mainScore}%</strong>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 210 }}>
          <Meter label="Outbound Calls" value={r.outbound} target={targets.outbound} color={COLORS.outbound} mounted={mounted} pace={live ? pace : null} />
          <Meter label="Real Conversations >1m" value={r.realConversations} target={targets.realConversations} color={COLORS.real} mounted={mounted} pace={live ? pace : null} />
        </div>
      </div>

      <div style={{ position: "relative", zIndex: 1, fontSize: 13, color: COLORS.inkSoft, marginTop: 10, fontStyle: "italic" }}>
        {coachLine(r, targets)}
      </div>

      <div style={{ position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12, color: COLORS.inkSoft, marginTop: 8, borderTop: "1px solid rgba(148,163,184,0.14)", paddingTop: 10 }}>
        <span>💪 Strong (&gt;3m): <strong style={{ color: COLORS.ink }}>{r.strongConversations}</strong></span>
        <span>📥 Inbound: <strong style={{ color: COLORS.ink }}>{r.inbound}</strong></span>
        <span>☎️ Total: <strong style={{ color: COLORS.ink }}>{r.totalCalls}</strong></span>
        <span title={`Calls under ${shortThreshold} seconds — they do not count toward talk time`}>
          ⏱️ Short (&lt;{shortThreshold}s): <strong style={{ color: COLORS.ink }}>{r.nonValuableCalls}</strong>
        </span>
        <span>🗣️ Raw talk: <strong style={{ color: COLORS.ink }}>{fmtTalk(r.totalTalkSeconds)}</strong></span>
      </div>
    </div>
  );
}

function HeroTile({ icon, label, value, sub }) {
  const shown = useCountUp(typeof value === "number" ? value : 0);
  return (
    <div style={{ background: COLORS.card, border: "1px solid rgba(148,163,184,0.16)", borderRadius: 14, padding: "14px 22px", textAlign: "center", minWidth: 150 }}>
      <div style={{ fontSize: 30, fontWeight: 900, color: COLORS.ink, fontVariantNumeric: "tabular-nums" }}>
        {icon} {typeof value === "number" ? shown : value}
      </div>
      <div style={{ fontSize: 12, color: COLORS.inkSoft, letterSpacing: 1, textTransform: "uppercase", marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: COLORS.inkMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const ctrlStyle = {
  background: "rgba(30,41,59,0.9)", color: COLORS.ink, border: "1px solid rgba(148,163,184,0.3)",
  borderRadius: 8, padding: "6px 12px", fontSize: 13, fontFamily: "inherit", cursor: "pointer",
};

export default function RecruitersPublicPage() {
  // view drives what the API is asked for: today (live) / one day / a range.
  const [view, setView] = useState({ mode: "today" });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [mounted, setMounted] = useState(false);
  const [clock, setClock] = useState(new Date());
  const [cheerIdx, setCheerIdx] = useState(0);
  const [pickDate, setPickDate] = useState("");
  const [pickStart, setPickStart] = useState("");
  const [pickEnd, setPickEnd] = useState("");

  const load = useCallback(async () => {
    try {
      const params = view.mode === "range"
        ? { start: view.start, end: view.end }
        : view.mode === "day" ? { date: view.date } : {};
      setData(await api.getPublicRecruiterStats(params));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [view]);

  useEffect(() => { load(); }, [load]);
  // Live auto-refresh only for today's board; pauses while the tab is hidden.
  // (A permanent wall display is never "hidden", so it stays live as before.)
  useVisibleInterval(load, REFRESH_MS, view.mode === "today");

  useEffect(() => {
    const clockTimer = setInterval(() => setClock(new Date()), 1000);
    const cheerTimer = setInterval(() => setCheerIdx((i) => (i + 1) % CHEERS.length), 8000);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
    return () => { clearInterval(clockTimer); clearInterval(cheerTimer); cancelAnimationFrame(raf); };
  }, []);

  const live = (data?.dateMode || "today") === "today";
  const pace = dayPaceFraction(clock);
  const targets = data?.targets || {
    talkSeconds: 9000, talkMinutes: 150, talkLabel: "2h 30m", outbound: 150, realConversations: 35,
  };
  const shortThreshold = data?.thresholds?.nonValuableMaxSeconds ?? 30;

  // Rank by main score, then talk progress, real talk time, outbound, strong.
  const ranked = useMemo(() => {
    const list = [...(data?.recruiters || [])];
    list.sort((a, b) =>
      ((b.mainScore ?? b.activityScore ?? 0) - (a.mainScore ?? a.activityScore ?? 0))
      || ((b.talkPct ?? 0) - (a.talkPct ?? 0))
      || ((b.valuableTalkSeconds ?? 0) - (a.valuableTalkSeconds ?? 0))
      || ((b.outboundPct ?? 0) - (a.outboundPct ?? 0))
      || ((b.strongConversations ?? 0) - (a.strongConversations ?? 0))
      || a.name.localeCompare(b.name));
    return list;
  }, [data]);

  const totals = useMemo(() => ({
    talk: ranked.reduce((s, r) => s + (r.valuableTalkSeconds || 0), 0),
    outbound: ranked.reduce((s, r) => s + (r.outbound || 0), 0),
    atTarget: ranked.filter((r) => r.talkMet).length,
  }), [ranked]);

  const talkLeader = useMemo(() => {
    const withTalk = ranked.filter((r) => (r.valuableTalkSeconds || 0) > 0);
    if (!withTalk.length) return null;
    return withTalk.reduce((best, r) => (r.valuableTalkSeconds > best.valuableTalkSeconds ? r : best));
  }, [ranked]);

  const goToday = () => { setView({ mode: "today" }); setPickDate(""); setPickStart(""); setPickEnd(""); };
  const goYesterday = () => {
    const y = new Date(clock);
    y.setDate(y.getDate() - 1);
    const d = isoDate(y);
    setPickDate(d);
    setView({ mode: "day", date: d });
  };
  const applyDate = (d) => { setPickDate(d); if (d) setView({ mode: "day", date: d }); };
  const applyRange = () => {
    if (pickStart && pickEnd) setView({ mode: "range", start: pickStart, end: pickEnd });
  };

  const viewLabel = live
    ? "Viewing today — live · auto-refreshes every minute"
    : data?.dateMode === "range"
      ? `Viewing date range · ${data?.startDate} → ${data?.endDate} (${data?.rangeDays} days)`
      : `Viewing historical day · ${data?.date || ""}`;

  return (
    <div style={{ minHeight: "100vh", background: `radial-gradient(1200px 600px at 20% -10%, rgba(124,58,237,0.22), transparent), radial-gradient(1000px 500px at 90% 0%, rgba(8,145,178,0.18), transparent), ${COLORS.surface}`, color: COLORS.ink, fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif", padding: "26px 22px 40px" }}>
      <style>{`
        .rlb-bar { transition: width 1.1s cubic-bezier(.22,1,.36,1); position: relative; }
        .rlb-bar::after {
          content: ""; position: absolute; inset: 0;
          background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.28) 50%, transparent 60%);
          animation: rlb-shimmer 2.6s infinite;
        }
        @keyframes rlb-shimmer { 0% { transform: translateX(-100%);} 60%,100% { transform: translateX(100%);} }
        .rlb-ring { transition: stroke-dashoffset 1.3s cubic-bezier(.22,1,.36,1); }
        .rlb-card { animation: rlb-rise .6s cubic-bezier(.22,1,.36,1) both; }
        @keyframes rlb-rise { from { opacity: 0; transform: translateY(18px);} to { opacity: 1; transform: none;} }
        .rlb-pulse { animation: rlb-pulse 1.6s ease-in-out infinite; }
        @keyframes rlb-pulse { 0%,100% { transform: scale(1);} 50% { transform: scale(1.07);} }
        .rlb-crushed { box-shadow: 0 0 34px rgba(22,163,74,0.22); }
        .rlb-leader { animation: rlb-rise .6s cubic-bezier(.22,1,.36,1) both, rlb-glow 2.8s ease-in-out infinite; }
        @keyframes rlb-glow {
          0%,100% { box-shadow: 0 0 18px rgba(124,58,237,0.18); }
          50% { box-shadow: 0 0 38px rgba(124,58,237,0.38); }
        }
        .rlb-confetti { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
        .rlb-confetti span {
          position: absolute; bottom: -22px; font-size: 14px; opacity: 0;
          animation: rlb-float 4.2s ease-in infinite;
        }
        @keyframes rlb-float {
          0% { transform: translateY(0) rotate(0); opacity: 0; }
          12% { opacity: .85; }
          100% { transform: translateY(-190px) rotate(38deg); opacity: 0; }
        }
        .rlb-cheer { animation: rlb-fade 8s ease-in-out infinite; }
        @keyframes rlb-fade { 0%,8% { opacity: 0;} 16%,84% { opacity: 1;} 94%,100% { opacity: 0;} }
        @media (prefers-reduced-motion: reduce) {
          .rlb-bar, .rlb-ring { transition: none; }
          .rlb-bar::after, .rlb-card, .rlb-leader, .rlb-pulse, .rlb-confetti span, .rlb-cheer { animation: none !important; opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, maxWidth: 1180, margin: "0 auto 14px" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 900, letterSpacing: 2 }}>🏆 RECRUITER LEADERBOARD</h1>
          <div style={{ color: COLORS.inkSoft, fontSize: 14, marginTop: 4 }}>
            Main KPI: <strong style={{ color: COLORS.ink }}>{targets.talkLabel} real call duration</strong>
            {" "}· Calls under {shortThreshold} seconds do not count
            {" "}· Secondary KPI: <strong style={{ color: COLORS.ink }}>{targets.outbound} outbound calls</strong>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
          <div style={{ fontSize: 12, color: COLORS.inkSoft }}>
            {live ? `Workday ${Math.round(pace * 100)}% elapsed` : viewLabel.replace("Viewing ", "")}
          </div>
        </div>
      </div>

      {/* Date controls + view mode */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, maxWidth: 1180, margin: "0 auto 18px" }}>
        <button style={{ ...ctrlStyle, borderColor: view.mode === "today" ? COLORS.talk : ctrlStyle.border, fontWeight: view.mode === "today" ? 800 : 500 }} onClick={goToday}>Today</button>
        <button style={ctrlStyle} onClick={goYesterday}>Yesterday</button>
        <label style={{ fontSize: 12, color: COLORS.inkSoft, display: "flex", alignItems: "center", gap: 6 }}>
          Day
          <input type="date" value={pickDate} max={isoDate(clock)} onChange={(e) => applyDate(e.target.value)} style={{ ...ctrlStyle, cursor: "auto" }} />
        </label>
        <span style={{ color: COLORS.inkMuted, fontSize: 12 }}>·</span>
        <label style={{ fontSize: 12, color: COLORS.inkSoft, display: "flex", alignItems: "center", gap: 6 }}>
          From
          <input type="date" value={pickStart} max={isoDate(clock)} onChange={(e) => setPickStart(e.target.value)} style={{ ...ctrlStyle, cursor: "auto" }} />
        </label>
        <label style={{ fontSize: 12, color: COLORS.inkSoft, display: "flex", alignItems: "center", gap: 6 }}>
          To
          <input type="date" value={pickEnd} max={isoDate(clock)} onChange={(e) => setPickEnd(e.target.value)} style={{ ...ctrlStyle, cursor: "auto" }} />
        </label>
        <button style={ctrlStyle} onClick={applyRange} disabled={!pickStart || !pickEnd}>Apply range</button>
        {!live && <button style={{ ...ctrlStyle, borderColor: COLORS.talk, fontWeight: 800 }} onClick={goToday}>← Back to Today</button>}
        <span style={{ fontSize: 12, color: live ? COLORS.good : COLORS.inkSoft, marginLeft: "auto" }}>
          {live ? "🟢 " : "🗓️ "}{viewLabel}
        </span>
      </div>

      {error && (
        <div style={{ maxWidth: 1180, margin: "0 auto 16px", padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(217,119,6,0.5)", background: "rgba(217,119,6,0.12)", color: COLORS.ink, fontSize: 14 }}>
          ⚠️ Couldn't load the board: {error}{live ? " — retrying automatically." : ""}
        </div>
      )}

      {/* Team hero tiles */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", maxWidth: 1180, margin: "0 auto 22px" }}>
        <HeroTile icon="🗣️" label={live ? "Team real talk time today" : "Team real talk time"} value={fmtTalk(totals.talk)} sub={`calls ≥ ${shortThreshold}s only`} />
        <HeroTile icon="📞" label="Team outbound calls" value={totals.outbound} />
        <HeroTile icon="🏆" label={`Recruiters at ${targets.talkLabel}`} value={totals.atTarget} sub={`of ${ranked.length} recruiter${ranked.length === 1 ? "" : "s"}`} />
        {talkLeader && (
          <HeroTile icon="🥇" label="Talk-time leader" value={talkLeader.name} sub={`${fmtTalk(talkLeader.valuableTalkSeconds)} real talk time`} />
        )}
      </div>

      {/* Leaderboard */}
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        {!data && !error ? (
          <div style={{ textAlign: "center", color: COLORS.inkSoft, padding: 60, fontSize: 16 }}>Loading the board…</div>
        ) : ranked.length === 0 ? (
          <div style={{ textAlign: "center", color: COLORS.inkSoft, padding: 60, fontSize: 16 }}>
            No recruiters on the board yet — add the team in the admin panel and let the games begin! 🎮
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>
            {ranked.map((r, idx) => (
              <RecruiterCard key={r.id} r={r} rank={idx} targets={targets} pace={pace} live={live} mounted={mounted} shortThreshold={shortThreshold} />
            ))}
          </div>
        )}
      </div>

      {/* Rotating cheer */}
      <div key={cheerIdx} className="rlb-cheer" style={{ textAlign: "center", marginTop: 30, fontSize: 16, color: COLORS.inkSoft, fontStyle: "italic" }}>
        {CHEERS[cheerIdx]}
      </div>
    </div>
  );
}
