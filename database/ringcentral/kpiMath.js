/**
 * Recruiter KPI arithmetic — PURE functions, no database and no I/O.
 *
 * The scoring rules live here so they can be asserted directly: talk time is
 * weighted 70% and outbound volume 30%, and a call shorter than the configured
 * threshold does not count as valuable. The KPI queries that feed these live in
 * ./kpiQueries.js.
 *
 * The default talk-time target sits here too, with the arithmetic that consumes
 * it — keeping it in the settings module would force this pure layer to import
 * a database module, and the settings reader already needs formatTalkLabel from
 * here. One direction only: settings → kpiMath, never back.
 *
 * Split out of database/ringcentral.js, which re-exports every symbol here.
 */
const { DateTime } = require('luxon');

// Main daily KPI: 2h 30m of REAL call duration per recruiter (calls shorter
// than nonValuableMaxSeconds — 30s by default — do not count toward it).
const DEFAULT_TARGET_TALK_SECONDS = 9000;

// ─── KPI math (pure, unit-tested) ───

/** "2h 30m" / "45m" style label for a number of seconds. */
function formatTalkLabel(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Effective KPI thresholds (seconds) from the settings row / defaults. */
function resolveThresholds(cfg = {}) {
  return {
    nonValuableMaxSeconds: cfg.nonValuableMaxSeconds ?? 30,
    realConversationMinSeconds: cfg.realConversationMinSeconds ?? 60,
    strongConversationMinSeconds: cfg.strongConversationMinSeconds ?? 180,
  };
}

/**
 * Targets for a reporting window. Per-day targets scale linearly with the
 * number of days (e.g. a 3-day range → 3 × 2h30m talk time, 3 × 150 outbound).
 */
function buildTargets(cfg = {}, rangeDays = 1) {
  const days = Math.max(1, Math.floor(Number(rangeDays) || 1));
  const talkSeconds = (cfg.targetTalkSeconds ?? DEFAULT_TARGET_TALK_SECONDS) * days;
  return {
    talkSeconds,
    talkMinutes: Math.round(talkSeconds / 60),
    talkLabel: formatTalkLabel(talkSeconds),
    outbound: (cfg.targetOutbound ?? 150) * days,
    realConversations: (cfg.targetRealConversations ?? 35) * days,
  };
}

/**
 * Aggregate a recruiter's calls into raw KPI totals.
 *
 * The main-KPI rule lives here: a call counts toward valuableTalkSeconds ONLY
 * when duration_seconds >= nonValuableMaxSeconds (default 30s). Shorter
 * non-zero calls are tallied separately as non-valuable. totalTalkSeconds
 * still includes everything, but is never the main KPI.
 */
function summarizeCalls(calls = [], thresholds = resolveThresholds()) {
  const totals = {
    totalCalls: 0,
    outbound: 0,
    inbound: 0,
    realConversations: 0,
    strongConversations: 0,
    nonValuableCalls: 0,
    nonValuableSeconds: 0,
    totalTalkSeconds: 0,
    valuableTalkSeconds: 0,
  };
  for (const call of calls) {
    if (!call) continue;
    totals.totalCalls += 1;
    if (call.direction === 'Outbound') totals.outbound += 1;
    else if (call.direction === 'Inbound') totals.inbound += 1;
    const d = Math.max(0, Number(call.durationSeconds ?? call.duration_seconds) || 0);
    totals.totalTalkSeconds += d;
    if (d >= thresholds.nonValuableMaxSeconds) {
      totals.valuableTalkSeconds += d;
    } else if (d > 0) {
      totals.nonValuableCalls += 1;
      totals.nonValuableSeconds += d;
    }
    if (d >= thresholds.realConversationMinSeconds) totals.realConversations += 1;
    if (d >= thresholds.strongConversationMinSeconds) totals.strongConversations += 1;
  }
  return totals;
}

/**
 * Score one recruiter's totals against the window targets.
 *
 * Main score = 70% real-talk-time progress + 30% outbound progress. The old
 * 50/50 (outbound + real conversations) score is retired; activityScore is
 * kept as an alias of mainScore for backward compatibility.
 */
function computeRecruiterKpis(totals, targets) {
  const talkPct = targets.talkSeconds
    ? Math.min(100, Math.round((totals.valuableTalkSeconds / targets.talkSeconds) * 100)) : 0;
  const outboundPct = targets.outbound
    ? Math.min(100, Math.round((totals.outbound / targets.outbound) * 100)) : 0;
  const realPct = targets.realConversations
    ? Math.min(100, Math.round((totals.realConversations / targets.realConversations) * 100)) : 0;
  const mainScore = Math.round(talkPct * 0.7 + outboundPct * 0.3);
  return {
    ...totals,
    // Back-compat alias: earlier payloads called the short-call count "nonValuable".
    nonValuable: totals.nonValuableCalls,
    talkPct,
    talkMet: totals.valuableTalkSeconds >= targets.talkSeconds,
    talkRemainingSeconds: Math.max(0, targets.talkSeconds - totals.valuableTalkSeconds),
    outboundPct,
    outboundMet: totals.outbound >= targets.outbound,
    realConversationsPct: realPct,
    realConversationsMet: totals.realConversations >= targets.realConversations,
    mainScore,
    activityScore: mainScore,
    targetTalkSeconds: targets.talkSeconds,
    targetTalkLabel: targets.talkLabel,
  };
}

module.exports = {
  DEFAULT_TARGET_TALK_SECONDS,
  formatTalkLabel,
  resolveThresholds,
  buildTargets,
  summarizeCalls,
  computeRecruiterKpis,
};
