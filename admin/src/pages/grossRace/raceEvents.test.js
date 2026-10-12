/**
 * The Gross Grand Prix's race feed: what comparing two readings announces.
 * Ported from the race design's feed; these pin what it announced.
 */
import { describe, expect, test } from "vitest";
import { BANNER_MS, raceEvents } from "./raceEvents";
import { bannerView, eventText } from "./raceView";

const racer = (id, rank, gross, pct, hitNames = []) => ({ id, name: id, rank, gross, pct, hitNames });
const AT = 1_000_000;

describe("raceEvents", () => {
  test("the first reading of a week announces nothing", () => {
    expect(raceEvents(null, [racer("Ann", 1, 9000, 0.6)], AT)).toEqual({ events: [], flashed: [], banner: null });
  });

  test("a load moves a racer: a gain, an overtake, and the banner says so", () => {
    const before = [racer("Ann", 1, 9000, 0.6), racer("Bo", 2, 8000, 0.5), racer("Cy", 3, 7000, 0.4)];
    const after = [racer("Ann", 1, 9000, 0.6), racer("Cy", 2, 9500, 0.55), racer("Bo", 3, 8000, 0.5)];
    const change = raceEvents(before, after, AT);
    expect(change.flashed).toEqual(["Cy"]);
    expect(change.events.map((e) => e.type)).toEqual(["overtake", "gain"]);
    expect(eventText(change.events[0])).toBe("Cy passes Bo for 2nd");
    expect(eventText(change.events[1])).toBe("Cy +$2,500");
    expect(change.banner).toMatchObject({ type: "overtake", until: AT + BANNER_MS });
    expect(bannerView(change.banner)).toEqual({ type: "overtake", kicker: "Overtake", text: "Cy passes Bo · 2nd" });
  });

  test("a new leader outranks every other banner; a finish and a driver on target are announced", () => {
    const before = [racer("Ann", 1, 14000, 0.93), racer("Bo", 2, 13000, 0.87)];
    const after = [racer("Bo", 1, 16000, 1.07, ["ZED DRIVER"]), racer("Ann", 2, 14000, 0.93)];
    const change = raceEvents(before, after, AT);
    expect(change.events.map((e) => e.type)).toEqual(["leader", "driver", "target", "gain"]);
    expect(eventText(change.events[1])).toBe("Zed Driver hit the weekly target for Bo");
    expect(eventText(change.events[2])).toBe("Bo reached 100% of target!");
    expect(bannerView(change.banner)).toEqual({ type: "leader", kicker: "New leader", text: "Bo takes 1st place!" });
  });

  test("a racer that only lost ground announces nothing", () => {
    const before = [racer("Ann", 1, 9000, 0.6), racer("Bo", 2, 8000, 0.5)];
    const after = [racer("Ann", 1, 8000, 0.53), racer("Bo", 2, 8000, 0.5)];
    expect(raceEvents(before, after, AT).events).toEqual([]);
  });
});
