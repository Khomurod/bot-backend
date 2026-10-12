/**
 * The Gross Grand Prix's lanes as values: which racers a screen shows and
 * where, for the teams' race to a target and the dispatchers' race by gross.
 */
import { describe, expect, test } from "vitest";
import { lanesView, pageCount, podiumView } from "./raceView";

const gross = (n) => ({
  racers: Array.from({ length: n }, (_, i) => ({
    id: `R${i + 1}`, name: `R${i + 1}`, rank: i + 1, gross: 50000 - i * 5000, loads: 3, miles: 10000, rpm: 2.5, gap: i * 5000,
  })),
  lead: 50000, topRpmId: null, rankBy: "gross",
});

describe("lanesView", () => {
  test("five lanes to a screen, placed by rank within the screen", () => {
    const race = gross(7);
    expect(pageCount(race, 5)).toBe(2);
    expect(pageCount(gross(5), 5)).toBe(1);
    const first = lanesView(race, { now: 0, page: 0, pageSize: 5 });
    expect(first.map((l) => l.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(first.map((l) => l.top)).toEqual(["0%", "20%", "40%", "60%", "80%"]);
    const second = lanesView(race, { now: 0, page: 1, pageSize: 5 });
    expect(second.map((l) => [l.rank, l.top, l.height])).toEqual([[6, "0%", "20%"], [7, "20%", "20%"]]);
  });

  test("a race by gross has no flag, no target and no percent", () => {
    const [leader, second] = lanesView(gross(2), { now: 0 });
    expect(leader.finishLeft).toBeNull();
    expect(leader.label).toBe("$50,000");
    expect(leader.result).toBe("3 loads", "the gross is on the token; this column counts loads");
    expect(leader.detail).toBe("Leader · RPM $2.50");
    expect(second.detail).toBe("−$5,000 to leader · RPM $2.50");
    expect(leader.lights).toEqual([]);
    expect(podiumView(gross(3))[1]).toMatchObject({ rank: 1, metric: "$50,000", gross: "3 loads" });
  });

  test("the teams' race keeps its flag and its target", () => {
    const race = {
      racers: [{ id: "T", name: "T", rank: 1, gross: 30000, target: 60000, pct: 0.5, gapPct: 0, gap: 0, loads: 2, miles: 1, rpm: 1, lights: [], hitNames: [] }],
      lead: 30000, leadPct: 0.5, maxTarget: 60000, topRpmId: null, rankBy: "percent",
    };
    const [lane] = lanesView(race, { now: 0 });
    expect(lane.finishLeft).not.toBeNull();
    expect(lane.result).toBe("$30,000 / $60k");
    expect(lane.label).toBe("50%");
  });
});
