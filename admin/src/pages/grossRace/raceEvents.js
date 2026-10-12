/**
 * What changed between two readings of the race: the lines for the race feed,
 * the racers whose lanes light up, and the one change worth the big banner.
 * Pure. Ported from the race design's own feed.
 */

export const EVENT_LIMIT = 12;
export const FLASH_MS = 6000;
export const BANNER_MS = 7000;

/**
 * @param {Array|null} previous racers of the last reading, best first; null on
 *   the first reading of a week, which announces nothing
 * @param {Array} current racers of this reading, best first
 * @param {number} at now, in ms
 * @returns {{ events: Array, flashed: Array<string>, banner: object|null }}
 *   `events` newest first.
 */
export function raceEvents(previous, current, at) {
  if (!previous) return { events: [], flashed: [], banner: null };
  const before = new Map(previous.map((racer) => [racer.id, racer]));
  const holderOf = new Map(previous.map((racer) => [racer.rank, racer]));
  const events = [];
  const flashed = [];
  for (const racer of current) {
    const old = before.get(racer.id);
    const gain = racer.gross - (old ? old.gross : 0);
    if (gain > 0.5) {
      events.push({ type: "gain", name: racer.name, amount: gain, at });
      flashed.push(racer.id);
    }
    if (!old) continue;
    if (racer.pct >= 1 && old.pct < 1) events.push({ type: "target", name: racer.name, at });
    const had = new Set(old.hitNames || []);
    for (const driver of racer.hitNames || []) {
      if (!had.has(driver)) events.push({ type: "driver", name: racer.name, driver, at });
    }
    if (racer.rank < old.rank) {
      const passed = holderOf.get(racer.rank);
      events.push({
        type: racer.rank === 1 ? "leader" : "overtake", name: racer.name, rank: racer.rank,
        passed: passed && passed.id !== racer.id ? passed.name : "", at,
      });
    }
  }
  const first = (type) => events.find((event) => event.type === type);
  const big = first("leader") || first("overtake") || first("target") || first("driver");
  return { events: events.reverse(), flashed, banner: big ? { ...big, until: at + BANNER_MS } : null };
}
