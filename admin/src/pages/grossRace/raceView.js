/**
 * The Gross Grand Prix screen, as values: what each part of the display shows
 * for one reading of GET /api/gross-race at one instant. Pure. Ported from the
 * race design's renderVals() and status().
 */

import { ago, clock, countdown, money, moneyK, ordinal, percent, rpm, scale, titleCase } from "./raceFormat";

const MUTED = "var(--color-neutral-700)";
const ACCENT = "var(--color-accent)";
const ACCENT_TEXT = "var(--color-accent-700)";
const PODIUM_HEIGHT = { 1: "clamp(80px,17vh,230px)", 2: "clamp(56px,12vh,160px)", 3: "clamp(40px,8vh,110px)" };

export const OTHER_DISPLAY = {
  teams: { href: "/dispatch", label: "Dispatchers race" },
  dispatchers: { href: "/dispatchteam", label: "Teams race" },
};

/** The status cell: live, warming up, or why not. */
export function statusView(data, now) {
  const warming = { label: "Warming up", color: MUTED, dot: "var(--color-neutral-500)", dotOpacity: 1 };
  if (!data) return { ...warming, line: "Connecting…" };
  if (!data.race) {
    if (data.status === "error") {
      return { label: "Offline", line: data.error || "No connection", color: ACCENT_TEXT, dot: ACCENT, dotOpacity: 1 };
    }
    return { ...warming, line: "Loading loads…" };
  }
  const updated = data.updatedAt ? "Updated " + clock(new Date(data.updatedAt), data.week.tz) : "Loading…";
  if (data.status === "stale") {
    return { label: "Live", line: updated + " · sync failed", color: ACCENT_TEXT, dot: ACCENT, dotOpacity: 1 };
  }
  return { label: "Live", line: updated, color: MUTED, dot: ACCENT, dotOpacity: Math.floor(now / 1000) % 2 ? 0.25 : 1 };
}

/** The week, the laps and the countdown. */
export function weekView(data, now) {
  const week = data && data.week;
  if (!week) {
    return { weekLabel: "…", lapLabel: "Lap –", laps: Array(7).fill("var(--color-neutral-300)"), countdown: "—" };
  }
  return {
    weekLabel: week.label,
    lapLabel: `Lap ${week.day} of 7 · ${week.dayName}`,
    laps: Array.from({ length: 7 }, (_, i) => (
      i < week.day - 1 ? "var(--color-text)" : i === week.day - 1 ? ACCENT : "var(--color-neutral-300)"
    )),
    countdown: countdown(Date.parse(week.end) - now),
  };
}

/** The race's racers, best first. */
export function ranked(race) {
  return race ? [...race.racers].sort((a, b) => a.rank - b.rank) : [];
}

const loadCount = (n) => n + (n === 1 ? " load" : " loads");

/** How many screens the racers take, `pageSize` lanes to a screen. */
export function pageCount(race, pageSize = Infinity) {
  return race && race.racers.length > pageSize ? Math.ceil(race.racers.length / pageSize) : 1;
}

/**
 * One lane per racer on screen, in the racers' stable order; `top` places it
 * by rank. With a `pageSize`, only the ranks on `page` are on screen, the way
 * an airport board shows a few flights at a time.
 */
export function lanesView(race, { now, flashUntil = {}, page = 0, pageSize = Infinity }) {
  if (!race) return [];
  const byPct = race.rankBy !== "gross";
  const max = byPct ? Math.max(1.12, race.leadPct * 1.22) : scale(Math.max(race.lead * 1.15, 5000));
  const first = Number.isFinite(pageSize) ? page * pageSize + 1 : 1;
  const last = Number.isFinite(pageSize) ? first + pageSize - 1 : race.racers.length;
  const n = Math.max(Math.min(race.racers.length, Number.isFinite(pageSize) ? pageSize : race.racers.length), 1);
  const along = (x) => "calc((100% - 2.3em) * " + x.toFixed(4) + ")";
  return race.racers.filter((racer) => racer.rank >= first && racer.rank <= last).map((racer) => {
    const value = byPct ? racer.pct : racer.gross;
    const p = Math.min(1, value / max);
    const leader = racer.rank === 1;
    const done = byPct && racer.target > 0 && racer.pct >= 1;
    const gap = byPct ? percent(racer.gapPct) : money(racer.gap);
    return {
      id: racer.id,
      name: racer.name,
      rank: racer.rank,
      top: ((racer.rank - first) * 100) / n + "%",
      height: 100 / n + "%",
      rowBg: (flashUntil[racer.id] || 0) > now ? "var(--color-accent-100)" : "transparent",
      trailWidth: along(p).replace(/\)$/, " + 1.15em)"),
      trailBg: leader ? "var(--color-accent-400)" : done ? MUTED : "var(--color-neutral-400)",
      tokenLeft: along(p),
      tokenBg: leader ? ACCENT : "var(--color-text)",
      labelLeft: along(p).replace(/\)$/, " + 2.3em)"),
      // The checkered flag is 100% of the target; a race by gross has none.
      finishLeft: byPct ? along(Math.min(1, 1 / max)).replace(/\)$/, " + 1.15em)") : null,
      labelColor: leader ? ACCENT_TEXT : "var(--color-text)",
      label: byPct ? percent(racer.pct) : money(racer.gross),
      // By gross, the gross is the token's label, so this column counts loads.
      result: byPct ? money(racer.gross) + " / " + moneyK(racer.target) : loadCount(racer.loads),
      detail: (leader ? "Leader" : "−" + gap + " to leader") + " · RPM " + (racer.miles ? rpm(racer.rpm) : "—"),
      detailColor: leader ? ACCENT_TEXT : MUTED,
      lights: (racer.lights || []).map((light) => ({ width: light.team ? ".9em" : ".42em", bg: light.hit ? ACCENT : "var(--color-neutral-400)" })),
      finished: done,
      topRpm: racer.id === race.topRpmId,
    };
  });
}

/** Lane text size: as large as the screen allows for this many lanes on it. */
export function laneFontSize(race, pageSize = Infinity) {
  const n = Math.max(Math.min(race ? race.racers.length : 0, pageSize), 1);
  return "clamp(14px, calc((100vh - 240px) * " + (0.28 / Math.max(n, 3)).toFixed(4) + "), 38px)";
}

/** The podium, drawn 2 · 1 · 3. */
export function podiumView(race) {
  const order = ranked(race);
  const byPct = !race || race.rankBy !== "gross";
  return [1, 0, 2].map((i) => {
    const racer = order[i];
    const rank = i + 1;
    return {
      rank,
      name: racer ? racer.name : "—",
      metric: racer ? (byPct ? percent(racer.pct) : money(racer.gross)) : "",
      gross: racer ? (byPct ? money(racer.gross) + " of " + moneyK(racer.target) : loadCount(racer.loads)) : "",
      metricColor: rank === 1 ? ACCENT_TEXT : "var(--color-text)",
      height: PODIUM_HEIGHT[rank],
      bg: !racer ? "var(--color-neutral-300)" : rank === 1 ? ACCENT : rank === 2 ? "var(--color-text)" : MUTED,
    };
  });
}

export function eventText(event) {
  if (event.type === "gain") return event.name + " +" + money(event.amount);
  if (event.type === "leader") return event.name + " takes the lead!";
  if (event.type === "overtake") {
    return event.passed
      ? event.name + " passes " + event.passed + " for " + ordinal(event.rank)
      : event.name + " moves up to " + ordinal(event.rank);
  }
  if (event.type === "driver") return titleCase(event.driver) + " hit the weekly target for " + event.name;
  return event.name + " reached 100% of target!";
}

/** The five newest lines of the race feed. */
export function feedView(events, now) {
  return events.slice(0, 5).map((event, i) => ({
    key: `${event.at}-${i}-${event.type}-${event.name}`,
    type: event.type,
    text: eventText(event),
    ago: ago(event.at, now),
    iconColor: event.type === "gain" ? "var(--color-text)" : ACCENT,
    bg: now - event.at < 15000 ? "var(--color-accent-100)" : "transparent",
  }));
}

/** The big banner's words for one event. */
export function bannerView(event) {
  const kicker = { leader: "New leader", overtake: "Overtake", driver: "Driver on target" }[event.type] || "Finish line";
  let text = event.name + " reached 100%!";
  if (event.type === "leader") text = event.name + " takes 1st place!";
  if (event.type === "overtake") text = event.name + (event.passed ? " passes " + event.passed : " moves up") + " · " + ordinal(event.rank);
  if (event.type === "driver") text = titleCase(event.driver) + " · " + event.name;
  return { type: event.type, kicker, text };
}

/** What the empty track says, when it is empty. */
export function emptyText(data) {
  if (!data || !data.race) return data && data.status === "error" && data.error ? data.error : "Lining up at the start…";
  return data.race.racers.length ? "" : "No deliveries yet this week. The first load takes pole position!";
}
