/**
 * Birthdays one after another, fifteen seconds each, each once per tab, and
 * none while something more important holds the screen.
 */
import { describe, expect, test } from "vitest";
import { act, renderHook } from "@testing-library/react";
import useBirthdays from "./useBirthdays";
import { BIRTHDAY_MS } from "./birthdayQueue";

const T = 50_000_000;
const list = [
  { key: "employee-7", kind: "employee", name: "Testbek" },
  { key: "driver-42", kind: "driver", name: "John Smith", truck: "1109" },
];
function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

describe("useBirthdays", () => {
  test("one after another, fifteen seconds each, then nothing", () => {
    const { result } = renderHook(() => useBirthdays({ storage: memoryStorage() }));
    act(() => { result.current.tick(list, T); });
    expect(result.current.current).toMatchObject({ name: "Testbek", until: T + BIRTHDAY_MS });
    expect(result.current.active.current).toBe(true);
    act(() => { result.current.tick(list, T + BIRTHDAY_MS - 1); });
    expect(result.current.current.name).toBe("Testbek");
    act(() => { result.current.tick(list, T + BIRTHDAY_MS); });
    expect(result.current.current).toBe(null);
    act(() => { result.current.tick(list, T + BIRTHDAY_MS + 1000); });
    expect(result.current.current.name).toBe("John Smith");
    act(() => { result.current.tick(list, T + 2 * BIRTHDAY_MS + 1000); });
    act(() => { result.current.tick(list, T + 2 * BIRTHDAY_MS + 2000); });
    expect(result.current.current).toBe(null);
  });

  test("waits while the screen is busy, then shows", () => {
    let busy = true;
    const { result } = renderHook(() => useBirthdays({ storage: memoryStorage(), isBusy: () => busy }));
    act(() => { result.current.tick(list, T); });
    expect(result.current.current).toBe(null);
    busy = false;
    act(() => { result.current.tick(list, T + 1000); });
    expect(result.current.current.name).toBe("Testbek");
  });

  test("once per tab: a page opened again in the same tab does not repeat them", () => {
    const storage = memoryStorage();
    const first = renderHook(() => useBirthdays({ storage }));
    act(() => { first.result.current.tick(list, T); });
    act(() => { first.result.current.tick(list, T + BIRTHDAY_MS); });
    first.unmount();
    const again = renderHook(() => useBirthdays({ storage }));
    act(() => { again.result.current.tick(list, T + BIRTHDAY_MS + 1000); });
    expect(again.result.current.current.name).toBe("John Smith");
  });
});
