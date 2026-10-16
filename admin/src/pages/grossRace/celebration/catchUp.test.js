/**
 * The one-off catch-up: only on a listed day, only after the 4 PM minute,
 * and once per tab.
 */
import { describe, expect, test } from "vitest";
import { CATCH_UP_DAYS, catchUpDay, caughtUp, markCaughtUp } from "./catchUp";

const TZ = "America/Chicago";
const at = (iso) => Date.parse(iso);

describe("catchUpDay", () => {
  test("16 October 2026 after 4 PM in Chicago, until midnight there; never before, never another day", () => {
    expect(CATCH_UP_DAYS.has("2026-10-16")).toBe(true);
    expect(catchUpDay(at("2026-10-16T20:59:00Z"), TZ)).toBe(null); // 3:59 PM
    expect(catchUpDay(at("2026-10-16T21:00:30Z"), TZ)).toBe(null); // the 4 PM minute: the usual celebration
    expect(catchUpDay(at("2026-10-16T21:01:00Z"), TZ)).toBe("2026-10-16");
    expect(catchUpDay(at("2026-10-17T04:59:00Z"), TZ)).toBe("2026-10-16"); // 11:59 PM
    expect(catchUpDay(at("2026-10-17T05:00:00Z"), TZ)).toBe(null);
    expect(catchUpDay(at("2026-10-19T22:00:00Z"), TZ)).toBe(null);
  });
});

describe("caughtUp", () => {
  test("remembered per tab; no storage means no memory and no error", () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    expect(caughtUp(storage, "2026-10-16")).toBe(false);
    markCaughtUp(storage, "2026-10-16");
    expect(caughtUp(storage, "2026-10-16")).toBe(true);
    expect(caughtUp(null, "2026-10-16")).toBe(false);
    expect(() => markCaughtUp(null, "2026-10-16")).not.toThrow();
  });
});
