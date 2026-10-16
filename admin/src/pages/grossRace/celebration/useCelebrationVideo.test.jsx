/**
 * When the video after the celebration plays: after a real celebration's car,
 * on the board that has it, when the server has one, once per celebration.
 */
import { describe, expect, test } from "vitest";
import { act, renderHook } from "@testing-library/react";
import useCelebrationVideo from "./useCelebrationVideo";

const party = { winner: { name: "Ann" }, until: 1 };

function setup(props = {}) {
  return renderHook((p) => useCelebrationVideo({ enabled: true, available: true, celebration: null, testing: { current: false }, ...p }),
    { initialProps: props });
}

describe("useCelebrationVideo", () => {
  test("fetched while the car is on, played once it is gone, done back to the board", () => {
    const { result, rerender } = setup();
    expect(result.current.stage).toBe(null);
    rerender({ celebration: party });
    expect(result.current.stage).toBe("ready");
    expect(result.current.active.current).toBe(true);
    rerender({ celebration: null });
    expect(result.current.stage).toBe("playing");
    act(() => result.current.done());
    expect(result.current.stage).toBe(null);
    expect(result.current.active.current).toBe(false);
  });

  test("a video that fails while the car is still on is not tried again for that celebration", () => {
    const { result, rerender } = setup({ celebration: party });
    expect(result.current.stage).toBe("ready");
    act(() => result.current.done());
    rerender({ celebration: party });
    expect(result.current.stage).toBe(null);
  });

  test("not on the dispatchers' board, not without a video, not for a sound test", () => {
    for (const props of [{ enabled: false }, { available: false }, { testing: { current: true } }]) {
      const { result, rerender } = setup(props);
      rerender({ ...props, celebration: party });
      rerender({ ...props, celebration: null });
      expect(result.current.stage).toBe(null);
      expect(result.current.active.current).toBe(false);
    }
  });
});
