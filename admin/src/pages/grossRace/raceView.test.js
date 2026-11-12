/**
 * The Gross Grand Prix's lanes as values: which racers a screen shows and
 * where, for the teams' race to a target and the dispatchers' race by gross.
 */
import { describe, expect, test } from "vitest";
import { lanesView, listView, podiumView, SPOTLIGHT } from "./raceView";

const gross = (n) => ({
  racers: Array.from({ length: n }, (_, i) => ({
    id: `R${i + 1}`, name: `R${i + 1}`, rank: i + 1, gross: 50000 - i * 5000, loads: 3, miles: 10000, rpm: 2.5, gap: i * 5000,
  })),
  lead: 50000, topRpmId: null, rankBy: "gross",
});

describe("lanesView", () => {
  test("the dispatchers' leaders: five lanes placed by rank, everybody after them in the list", () => {
    const race = gross(7);
    const lanes = lanesView(race, { now: 0, limit: SPOTLIGHT });
    expect(lanes.map((l) => l.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(lanes.map((l) => l.top)).toEqual(["0%", "20%", "40%", "60%", "80%"]);
    const rows = listView(race, { now: 0, flashUntil: { R7: 10 } });
    expect(rows.map((r) => [r.rank, r.top, r.height])).toEqual([[6, "0%", "50%"], [7, "50%", "50%"]]);
    expect(rows[0]).toMatchObject({ name: "R6", gross: "$25,000", loads: "3", bar: "50.0%", rowBg: "transparent" });
    expect(rows[1].rowBg).toBe("var(--color-accent-100)", "a gain lights the row up, as it does a lane");
    expect(listView(gross(SPOTLIGHT), { now: 0 })).toEqual([]);
    expect(lanesView(gross(3), { now: 0, limit: SPOTLIGHT }).map((l) => l.height)).toEqual(["33.333333333333336%", "33.333333333333336%", "33.333333333333336%"]);
  });

  test("a gross label never runs past the end of the road: the token stops short by its width", () => {
    const [leader] = lanesView(gross(2), { now: 0 });
    expect(leader.tokenLeft).toMatch(/^calc\(\(100% - 7\.3em\) \* 0\.\d+\)$/);
    const team = lanesView({
      racers: [{ id: "T", name: "T", rank: 1, gross: 1, target: 2, pct: 0.5, gapPct: 0, gap: 0, loads: 1, miles: 1, rpm: 1, lights: [], hitNames: [] }],
      lead: 1, leadPct: 0.5, maxTarget: 2, topRpmId: null, rankBy: "percent",
    }, { now: 0 });
    expect(team[0].tokenLeft).toMatch(/^calc\(\(100% - 2\.3em\)/, "the teams' percent is short: their road is unchanged");
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
