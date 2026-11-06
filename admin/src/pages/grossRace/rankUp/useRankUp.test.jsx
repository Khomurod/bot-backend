/**
 * The climb card's timing: one card for seven seconds, at most one a minute,
 * never while the screen is busy, the board turned to the climber's page, and
 * the chime's answer on the card.
 */
import { describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import useRankUp, { RANK_UP_MS, TEST_CLIMB } from "./useRankUp";
import { RANK_UP_COOLDOWN_MS } from "./pickRankUp";

const T = 9_000_000;
const overtake = (name, from, rank) => ({ type: rank === 1 ? "leader" : "overtake", name, from, rank, passed: "Bo", at: T });

describe("useRankUp", () => {
  test("a climb shows the card for seven seconds, chimes once, and turns the board to the climber's page", async () => {
    const chime = vi.fn(async () => true);
    const setPage = vi.fn();
    const { result } = renderHook(() => useRankUp({ chime, setPage, pageSize: 5 }));
    act(() => { result.current.offer([overtake("Gus", 9, 7)], T); });
    expect(result.current.card).toMatchObject({ name: "Gus", rank: 7, from: 9, until: T + RANK_UP_MS });
    expect(result.current.showing.current).toBe(true);
    expect(setPage).toHaveBeenCalledWith(1);
    await waitFor(() => expect(result.current.card.chimed).toBe(true));
    expect(chime).toHaveBeenCalledTimes(1);

    act(() => { result.current.tick(T + RANK_UP_MS - 1); });
    expect(result.current.card).not.toBe(null);
    act(() => { result.current.tick(T + RANK_UP_MS); });
    expect(result.current.card).toBe(null);
    expect(result.current.showing.current).toBe(false);
  });

  test("the teams' board has one page: nothing to turn", () => {
    const setPage = vi.fn();
    const { result } = renderHook(() => useRankUp({ chime: async () => true, setPage }));
    act(() => { result.current.offer([overtake("Cy", 3, 2)], T); });
    expect(result.current.card).toMatchObject({ name: "Cy" });
    expect(setPage).not.toHaveBeenCalled();
  });

  test("at most one card a minute, and none over another", () => {
    const { result } = renderHook(() => useRankUp({ chime: async () => true }));
    act(() => { result.current.offer([overtake("Cy", 3, 2)], T); });
    act(() => { result.current.offer([overtake("Di", 5, 4)], T + 1000); });
    expect(result.current.card.name).toBe("Cy");
    act(() => { result.current.tick(T + RANK_UP_MS); });
    act(() => { result.current.offer([overtake("Di", 5, 4)], T + 30_000); });
    expect(result.current.card).toBe(null);
    act(() => { result.current.offer([overtake("Di", 5, 4)], T + RANK_UP_COOLDOWN_MS); });
    expect(result.current.card.name).toBe("Di");
  });

  test("never while the celebration, the video or the sound test holds the screen", () => {
    let busy = true;
    const chime = vi.fn(async () => true);
    const { result } = renderHook(() => useRankUp({ chime, isBusy: () => busy }));
    act(() => { result.current.offer([overtake("Cy", 3, 2)], T); });
    act(() => { result.current.test(); });
    expect(result.current.card).toBe(null);
    expect(chime).not.toHaveBeenCalled();
    busy = false;
    act(() => { result.current.offer([overtake("Cy", 3, 2)], T + 1000); });
    expect(result.current.card).toMatchObject({ name: "Cy" });
  });

  test("a chime the browser refuses: the card still shows, and says it did not play", async () => {
    const { result } = renderHook(() => useRankUp({ chime: async () => { throw new Error("no audio"); } }));
    act(() => { result.current.offer([overtake("Cy", 3, 2)], T); });
    await waitFor(() => expect(result.current.card.chimed).toBe(false));
    expect(result.current.card.name).toBe("Cy");
  });

  test("Test sound: the card and the chime, with what the page-load probe found", async () => {
    const { result } = renderHook(() => useRankUp({ chime: async () => true, probe: async () => "blocked", probeOnLoad: true }));
    await waitFor(() => expect(result.current.autoplay).toBe("blocked"));
    act(() => { result.current.test(); });
    expect(result.current.card).toMatchObject({ ...TEST_CLIMB, autoplay: "blocked" });
    await waitFor(() => expect(result.current.card.chimed).toBe(true));
  });

  test("a new week clears the card and the minute's pause", () => {
    const { result } = renderHook(() => useRankUp({ chime: async () => true }));
    act(() => { result.current.offer([overtake("Cy", 3, 2)], T); });
    act(() => { result.current.clear(); });
    expect(result.current.card).toBe(null);
    act(() => { result.current.offer([overtake("Di", 5, 4)], T + 1000); });
    expect(result.current.card.name).toBe("Di");
  });
});
