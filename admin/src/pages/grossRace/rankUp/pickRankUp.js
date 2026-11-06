/**
 * Which climb gets the chime and the big card (the owner, 6 November 2026).
 * Pure.
 *
 * Only an overtake counts — `overtake` and `leader` from raceEvents.js; a racer
 * appearing on the board for the first time is not a climb. At most one card a
 * minute: a climb inside the pause is not queued, because it is already in the
 * feed. When several racers climbed at once the card goes to the biggest climb
 * (most places gained; on a tie, the better place it reached), and a new
 * leader always wins.
 */
export const RANK_UP_COOLDOWN_MS = 60_000;

const climbOf = (event) => Math.max(0, Number(event.from) - Number(event.rank)) || 0;

/**
 * @param {Array} events this reading's events (raceEvents().events)
 * @param {number|null} lastShownAt when the last card was shown, in ms
 * @param {number} now in ms
 * @returns {object|null} `{ name, rank, from, passed, leader }`
 */
export function pickRankUp(events, lastShownAt, now) {
  const climbs = (events || []).filter((e) => (e.type === "overtake" || e.type === "leader") && climbOf(e) > 0);
  if (!climbs.length) return null;
  if (lastShownAt != null && now - lastShownAt < RANK_UP_COOLDOWN_MS) return null;
  const best = [...climbs].sort((a, b) => (
    Number(b.type === "leader") - Number(a.type === "leader")
    || climbOf(b) - climbOf(a)
    || a.rank - b.rank
  ))[0];
  return {
    name: best.name, rank: best.rank, from: best.from, passed: best.passed || "", leader: best.type === "leader",
  };
}

/** "1st", "2nd", "3rd", "4th" … "11th", "12th", "13th", "21st". */
export function ordinal(n) {
  const v = Math.abs(Number(n)) % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" })[v % 10] || "th"}`;
}
