/**
 * Which climb gets the chime and the big card: overtakes only, a new leader
 * first, then the biggest climb, and at most one card a minute.
 */
import { describe, expect, test } from "vitest";
import { RANK_UP_COOLDOWN_MS, ordinal, pickRankUp } from "./pickRankUp";

const NOW = 5_000_000;
const climb = (name, from, rank, extra = {}) => ({ type: rank === 1 ? "leader" : "overtake", name, from, rank, passed: "Someone", at: NOW, ...extra });

describe("pickRankUp", () => {
  test("nothing to show without an overtake: gains, targets and a driver on target are not climbs", () => {
    expect(pickRankUp([], null, NOW)).toBe(null);
    expect(pickRankUp([{ type: "gain", name: "Ann", amount: 900 }, { type: "target", name: "Ann" }, { type: "driver", name: "Ann", driver: "X" }], null, NOW)).toBe(null);
    expect(pickRankUp(null, null, NOW)).toBe(null);
  });

  test("an overtake: who, from where to where, and whom they passed", () => {
    expect(pickRankUp([climb("Cy", 5, 3, { passed: "Bo" })], null, NOW)).toEqual({
      name: "Cy", rank: 3, from: 5, passed: "Bo", leader: false,
    });
  });

  test("a new leader always wins, even over a bigger climb", () => {
    const pick = pickRankUp([climb("Gus", 9, 2), climb("Ann", 2, 1)], null, NOW);
    expect(pick).toMatchObject({ name: "Ann", leader: true, rank: 1, from: 2 });
  });

  test("otherwise the most places gained, then the better place reached", () => {
    expect(pickRankUp([climb("Bo", 4, 3), climb("Gus", 9, 5)], null, NOW).name).toBe("Gus");
    expect(pickRankUp([climb("Bo", 6, 5), climb("Cy", 3, 2)], null, NOW).name).toBe("Cy");
  });

  test("at most one card a minute: a climb inside the pause is not shown, one after it is", () => {
    const events = [climb("Cy", 5, 3)];
    expect(pickRankUp(events, NOW - 10_000, NOW)).toBe(null);
    expect(pickRankUp(events, NOW - RANK_UP_COOLDOWN_MS + 1, NOW)).toBe(null);
    expect(pickRankUp(events, NOW - RANK_UP_COOLDOWN_MS, NOW)).toMatchObject({ name: "Cy" });
  });

  test("an event without a real climb is ignored", () => {
    expect(pickRankUp([{ type: "overtake", name: "Cy", rank: 3, from: 3 }], null, NOW)).toBe(null);
    expect(pickRankUp([{ type: "overtake", name: "Cy", rank: 3 }], null, NOW)).toBe(null);
  });
});

describe("ordinal", () => {
  test("English place words", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal))
      .toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  });
});
