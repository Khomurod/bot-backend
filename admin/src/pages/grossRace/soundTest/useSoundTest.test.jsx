/**
 * The "Test sound" button's run: the celebration first, then the clip; the
 * page-load answer about sound is there before anybody presses anything.
 */
import { describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import useSoundTest, { TEST_WINNER } from "./useSoundTest";

const leader = { id: "Ann", name: "Ann", rank: 1, gross: 5000 };
const race = { racers: [leader] };

function setup(props = {}) {
  const setCelebration = vi.fn();
  const probe = vi.fn(async () => "blocked");
  const hook = renderHook((p) => useSoundTest({ race, celebration: null, setCelebration, probe, ...p }), { initialProps: props });
  return { ...hook, setCelebration, probe };
}

describe("useSoundTest", () => {
  test("asks about sound once, when the page opens", async () => {
    const { result, probe } = setup();
    expect(result.current.autoplay).toBe("checking");
    await waitFor(() => expect(result.current.autoplay).toBe("blocked"));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("a press celebrates the leader, then moves on to the clip; a second press meanwhile does nothing", async () => {
    const { result, rerender, setCelebration } = setup();
    act(() => result.current.start());
    expect(setCelebration).toHaveBeenCalledWith(expect.objectContaining({ winner: leader }));
    expect(result.current.active.current).toBe(true);
    act(() => result.current.start());
    expect(setCelebration).toHaveBeenCalledTimes(1);

    rerender({ celebration: { winner: leader, until: Date.now() + 12_000 } });
    act(() => result.current.noteCar("off"));
    expect(result.current.test).toEqual({ stage: "car", car: "off" });

    rerender({ celebration: null });
    expect(result.current.test).toEqual({ stage: "video", car: "off" });

    act(() => result.current.close());
    expect(result.current.test).toBe(null);
    expect(result.current.active.current).toBe(false);
  });

  test("with nobody on the board yet, it still runs, for a stand-in", () => {
    const { result, setCelebration } = setup({ race: null });
    act(() => result.current.start());
    expect(setCelebration).toHaveBeenCalledWith(expect.objectContaining({ winner: TEST_WINNER }));
  });

  test("the real 4 PM celebration's car is not a test's", () => {
    const { result } = setup();
    act(() => result.current.noteCar("on"));
    expect(result.current.test).toBe(null);
  });
});
