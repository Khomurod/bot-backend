/**
 * When the board celebrates (4:00 PM in Chicago, once a day, every day) and
 * whom (the board's leader, once anybody has gross).
 */
import { describe, expect, test } from "vitest";
import { celebrationCue, celebrationWinner } from "./celebrationTime";

const TZ = "America/Chicago";
const at = (iso) => Date.parse(iso);

describe("celebrationCue", () => {
  test("4:00 PM in Chicago, the whole minute, and the three minutes before to fetch the car", () => {
    // 12 October 2026 is daylight time: 4 PM CDT is 21:00 UTC.
    expect(celebrationCue(at("2026-10-12T20:56:59Z"), TZ, null).cue).toBe(null);
    expect(celebrationCue(at("2026-10-12T20:57:00Z"), TZ, null).cue).toBe("preload");
    expect(celebrationCue(at("2026-10-12T20:59:59Z"), TZ, null).cue).toBe("preload");
    expect(celebrationCue(at("2026-10-12T21:00:00Z"), TZ, null)).toEqual({ cue: "show", day: "2026-10-12" });
    expect(celebrationCue(at("2026-10-12T21:00:59Z"), TZ, null).cue).toBe("show");
    expect(celebrationCue(at("2026-10-12T21:01:00Z"), TZ, null).cue).toBe(null);
  });

  test("once a day: not again the same afternoon, but again the next day, weekends included", () => {
    expect(celebrationCue(at("2026-10-12T21:00:30Z"), TZ, "2026-10-12").cue).toBe(null);
    expect(celebrationCue(at("2026-10-18T21:00:00Z"), TZ, "2026-10-12")).toEqual({ cue: "show", day: "2026-10-18" });
  });

  test("standard time: 4 PM CST is 22:00 UTC", () => {
    expect(celebrationCue(at("2026-11-02T21:00:00Z"), TZ, null).cue).toBe(null);
    expect(celebrationCue(at("2026-11-02T22:00:00Z"), TZ, null).cue).toBe("show");
  });
});

describe("celebrationWinner", () => {
  test("the board's leader by rank, not by gross: on the teams board that is the share of target", () => {
    const race = {
      racers: [
        { id: "A", name: "A", rank: 2, gross: 50000 },
        { id: "B", name: "B", rank: 1, gross: 30000 },
      ],
    };
    expect(celebrationWinner(race).name).toBe("B");
  });

  test("nobody to celebrate before the first load", () => {
    expect(celebrationWinner(null)).toBe(null);
    expect(celebrationWinner({ racers: [] })).toBe(null);
    expect(celebrationWinner({ racers: [{ id: "A", name: "A", rank: 1, gross: 0 }] })).toBe(null);
  });
});
