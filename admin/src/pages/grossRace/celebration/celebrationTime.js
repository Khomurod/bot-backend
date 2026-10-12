/**
 * When the Gross Grand Prix celebrates its leader, and who that is. Pure.
 *
 * Every day at 4:00 PM in Chicago (the owner, 12 October 2026), each screen
 * shows the race leader for twelve seconds: on /dispatch the dispatcher with
 * the most gross, on /dispatchteam the team leading the race (by its share of
 * target, the board's own ranking). A screen fetches the car a few minutes
 * early so it is ready on the minute.
 */
import { ranked } from "../raceView";

export const CELEBRATION_HOUR = 16;
export const CELEBRATION_MS = 12_000;
export const PRELOAD_MINUTES = 3;
export const MESSAGE = "You took first place! Keep it up, and one day you'll buy a great new car.";

const formats = new Map();
function zoneClock(at, tz) {
  let format = formats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    formats.set(tz, format);
  }
  const part = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return { day: `${part.year}-${part.month}-${part.day}`, minutes: (Number(part.hour) % 24) * 60 + Number(part.minute) };
}

/**
 * What a screen should do at `now` (ms): "show" during 4:00 PM, the minute
 * itself, unless it already celebrated on that day; "preload" in the minutes
 * before; otherwise null. `day` is the calendar day in `tz`.
 */
export function celebrationCue(now, tz, shownDay) {
  const { day, minutes } = zoneClock(new Date(now), tz);
  const at = CELEBRATION_HOUR * 60;
  if (minutes === at) return { cue: day === shownDay ? null : "show", day };
  if (minutes >= at - PRELOAD_MINUTES && minutes < at) return { cue: "preload", day };
  return { cue: null, day };
}

/** The racer to celebrate: the board's leader, if anybody has gross yet. */
export function celebrationWinner(race) {
  const [leader] = ranked(race);
  return leader && leader.gross > 0 ? leader : null;
}

/**
 * One tick of a screen's 4 PM check: whether to fetch the car, and whom to
 * celebrate now. `day` comes back only with a winner: the day counts as
 * celebrated once somebody WAS, so a screen opened at 4:00 whose race is
 * still loading celebrates when it arrives, within the minute.
 */
export function celebrationTick(now, tz, celebratedOn, race) {
  const { cue, day } = celebrationCue(now, tz, celebratedOn);
  if (cue !== "show") return { preload: cue === "preload", winner: null, day: null };
  const winner = celebrationWinner(race);
  return { preload: false, winner, day: winner ? day : null };
}
