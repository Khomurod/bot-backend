import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";

/**
 * /recruiters — public, full-screen, gamified daily leaderboard.
 *
 * Meant to live on a wall screen or a recruiter's second monitor: today's call
 * KPIs per recruiter, ranked by the 50/50 score, with animated meters, ring
 * gauges, a live day-pace marker, and loud celebration for whoever is crushing
 * the targets. Auto-refreshes every 60 seconds. No auth, no phone numbers —
 * names and numbers-of-calls only.
 *
 * Metric colors are palette-validated for the dark surface (lightness band,
 * CVD separation, contrast): cyan #0891b2 outbound · green #16a34a real conv ·
 * amber #d97706 strong · purple #7c3aed score. Every meter is direct-labeled,
 * and rank/status always carry an icon + text, never color alone.
 */

const COLORS = {
  outbound: "#0891b2",
  real: "#16a34a",
  strong: "#d97706",
  score: "#7c3aed",
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
  "Every dial is a chance. Every conversation is a win. 📞",
  "The phone won't dial itself — 150 today, let's go!",
  "Talk time beats hold time. Get past the first 30 seconds!",
  "Strong conversations build strong fleets. 3 minutes or more! 💪",
  "50% activity, 50% conversion — win both halves of the day.",
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
  const s = Number(seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Animated horizontal meter with a direct value/target label + day-pace tick. */
function Meter({ label, value, target, color, mounted, pace }) {
  const shown = useCountUp(value);
  const pct = target ? Math.min(100, (value / target) * 100) : 0;
  const met = target != null && value >= target;
  return (
    <div style={{ marginBottom: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
        <span style={{ fontSize: 13, color: COLORS.inkSoft }}>{label}</span>
        <span style={{ fontSize: 15, fontWeight: 800, color: met ? COLORS.good : COLORS.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {met ? "✓ " : ""}{shown}
          {target != null && <span style={{ color: COLORS.inkMuted, fontWeight: 500 }}> / {target}</span>}
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

/** Animated SVG ring gauge for the 50/50 score. */
function ScoreRing({ score, mounted, size = 108 }) {
  const shown = useCountUp(score);
  const r = (size - 14) / 2;
  const C = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, score));
  return (
    <svg width={size} height={size} role="img" aria-label={`50/50 score ${score}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(148,163,184,0.16)" strokeWidth="10" />
      <circle
        className="rlb-ring"
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={score >= 100 ? COLORS.good : COLORS.score}
        strokeWidth="10" strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={mounted ? C * (1 - pct / 100) : C}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="47%" textAnchor="middle" fill={COLORS.ink} fontSize="24" fontWeight="800" fontFamily="inherit">
        {shown}%
      </text>
      <text x="50%" y="64%" textAnchor="middle" fill={COLORS.inkMuted} fontSize="10" fontFamily="inherit">
        50/50 SCORE
      </text>
    </svg>
  );
}

function statusFor(r, pace) {
  if (r.outboundMet && r.realConversationsMet) {
    return { icon: "👑", text: "KPI CRUSHED", color: COLORS.good, crushed: true };
  }
  const expected = pace * 100;
  const worst = Math.min(r.outboundPct, r.realConversationsPct);
  if (worst >= expected - 5) return { icon: "🔥", text: "ON PACE", color: COLORS.ink, crushed: false };
  if (worst >= expected - 25) return { icon: "⚡", text: "PUSH HARDER", color: COLORS.warn, crushed: false };
  return { icon: "🚨", text: "TIME TO DIAL", color: COLORS.warn, crushed: false };
}

const MEDALS = ["🥇", "🥈", "🥉"];

function RecruiterCard({ r, rank, targets, pace, mounted }) {
  const status = statusFor(r, pace);
  const isLeader = rank === 0 && (r.outbound > 0 || r.realConversations > 0);
  return (
    <div
      className={`rlb-card ${status.crushed ? "rlb-crushed" : ""}`}
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
        <ScoreRing score={r.activityScore} mounted={mounted} />
        <div style={{ flex: 1, minWidth: 210 }}>
          <Meter label="Total Outbound" value={r.outbound} target={targets.outbound} color={COLORS.outbound} mounted={mounted} pace={pace} />
          <Meter label="Real Conversations >1m" value={r.realConversations} target={targets.realConversations} color={COLORS.real} mounted={mounted} pace={pace} />
        </div>
      </div>

      <div style={{ position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12, color: COLORS.inkSoft, marginTop: 10, borderTop: "1px solid rgba(148,163,184,0.14)", paddingTop: 10 }}>
        <span>💪 Strong (&gt;3m): <strong style={{ color: COLORS.ink }}>{r.strongConversations}</strong></span>
        <span>📥 Inbound: <strong style={{ color: COLORS.ink }}>{r.inbound}</strong></span>
        <span>🗣️ Talk: <strong style={{ color: COLORS.ink }}>{fmtTalk(r.totalTalkSeconds)}</strong></span>
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

export default function RecruitersPublicPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [mounted, setMounted] = useState(false);
  const [clock, setClock] = useState(new Date());
  const [cheerIdx, setCheerIdx] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await api.getPublicRecruiterStats());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const dataTimer = setInterval(load, REFRESH_MS);
    const clockTimer = setInterval(() => setClock(new Date()), 1000);
    const cheerTimer = setInterval(() => setCheerIdx((i) => (i + 1) % CHEERS.length), 8000);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
    return () => { clearInterval(dataTimer); clearInterval(clockTimer); clearInterval(cheerTimer); cancelAnimationFrame(raf); };
  }, [load]);

  const pace = dayPaceFraction(clock);
  const targets = data?.targets || { outbound: 150, realConversations: 35 };

  const ranked = useMemo(() => {
    const list = [...(data?.recruiters || [])];
    list.sort((a, b) => (b.activityScore - a.activityScore) || (b.outbound - a.outbound) || a.name.localeCompare(b.name));
    return list;
  }, [data]);

  const totals = useMemo(() => ({
    outbound: ranked.reduce((s, r) => s + r.outbound, 0),
    real: ranked.reduce((s, r) => s + r.realConversations, 0),
    crushed: ranked.filter((r) => r.outboundMet && r.realConversationsMet).length,
  }), [ranked]);

  const leader = ranked[0];

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
          .rlb-bar::after, .rlb-card, .rlb-pulse, .rlb-confetti span, .rlb-cheer { animation: none !important; opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, maxWidth: 1180, margin: "0 auto 20px" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 900, letterSpacing: 2 }}>🏆 RECRUITER LEADERBOARD</h1>
          <div style={{ color: COLORS.inkSoft, fontSize: 14, marginTop: 4 }}>
            {data?.date ? new Date(`${data.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : "Today"} · The 50/50 Rule: 50% Activity + 50% Conversion
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
          <div style={{ fontSize: 12, color: COLORS.inkSoft }}>
            Workday {Math.round(pace * 100)}% elapsed · auto-refreshes every minute
          </div>
        </div>
      </div>

      {error && (
        <div style={{ maxWidth: 1180, margin: "0 auto 16px", padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(217,119,6,0.5)", background: "rgba(217,119,6,0.12)", color: COLORS.ink, fontSize: 14 }}>
          ⚠️ Couldn't refresh the board: {error} — retrying automatically.
        </div>
      )}

      {/* Team hero tiles */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", maxWidth: 1180, margin: "0 auto 22px" }}>
        <HeroTile icon="📞" label="Team outbound today" value={totals.outbound} />
        <HeroTile icon="💬" label="Real conversations" value={totals.real} />
        <HeroTile icon="👑" label="KPIs crushed" value={totals.crushed} sub={`of ${ranked.length} recruiter${ranked.length === 1 ? "" : "s"}`} />
        {leader && (leader.outbound > 0 || leader.realConversations > 0) && (
          <HeroTile icon="🥇" label="Leading right now" value={leader.name} sub={`${leader.activityScore}% 50/50 score`} />
        )}
      </div>

      {/* Leaderboard */}
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        {!data && !error ? (
          <div style={{ textAlign: "center", color: COLORS.inkSoft, padding: 60, fontSize: 16 }}>Loading today's board…</div>
        ) : ranked.length === 0 ? (
          <div style={{ textAlign: "center", color: COLORS.inkSoft, padding: 60, fontSize: 16 }}>
            No recruiters on the board yet — add the team in the admin panel and let the games begin! 🎮
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
            {ranked.map((r, idx) => (
              <RecruiterCard key={r.id} r={r} rank={idx} targets={targets} pace={pace} mounted={mounted} />
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
