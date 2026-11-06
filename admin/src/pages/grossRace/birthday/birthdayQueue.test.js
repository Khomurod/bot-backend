/**
 * Whose birthday a screen shows next: in the order they went out, each once
 * per tab, remembered across the board's own reload, and never an error when
 * the tab's storage is missing or full.
 */
import { describe, expect, test } from "vitest";
import { SHOWN_KEY, markShown, nextBirthday, readShown } from "./birthdayQueue";

const b = (key, name = key) => ({ key, kind: "driver", name, truck: "1" });

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

describe("birthdayQueue", () => {
  test("the first not shown yet, in the server's order", () => {
    const list = [b("driver-1"), b("employee-7"), b("driver-2")];
    expect(nextBirthday(list, new Set())).toBe(list[0]);
    expect(nextBirthday(list, new Set(["driver-1"]))).toBe(list[1]);
    expect(nextBirthday(list, new Set(["driver-1", "employee-7", "driver-2"]))).toBe(null);
    expect(nextBirthday(null, new Set())).toBe(null);
    expect(nextBirthday([{ key: "x" }, null], new Set())).toBe(null);
  });

  test("what was shown survives a reload of the tab", () => {
    const storage = memoryStorage();
    const shown = readShown(storage);
    markShown(storage, shown, "driver-1");
    expect([...readShown(storage)]).toEqual(["driver-1"]);
  });

  test("storage missing, unreadable or refusing a write: shown is still remembered in the page", () => {
    expect(readShown(null).size).toBe(0);
    expect(readShown({ getItem: () => "{not json" }).size).toBe(0);
    expect(readShown({ getItem: () => JSON.stringify({ a: 1 }) }).size).toBe(0);
    const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
    const shown = markShown(full, new Set(), "driver-1");
    expect(nextBirthday([b("driver-1")], shown)).toBe(null);
    expect(markShown(null, new Set(), "x").has("x")).toBe(true);
  });

  test("only the last hundred keys are kept", () => {
    const storage = memoryStorage();
    const shown = new Set();
    for (let i = 0; i < 130; i += 1) markShown(storage, shown, `driver-${i}`);
    const kept = JSON.parse(storage.map.get(SHOWN_KEY));
    expect(kept).toHaveLength(100);
    expect(kept[0]).toBe("driver-30");
  });
});
