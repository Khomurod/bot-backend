/**
 * The full-screen SOS presentation timer, mounted for real in jsdom with fake
 * timers: the 10:00 start, elapsed-time-based counting (including while a
 * message is on screen), the countdown/message transitions, pause / continue /
 * restart, the 00:00 completion state, exit + cleanup, the single-interval
 * guarantee, the fullscreen request and its denial fallback, Escape, and the
 * TEST marker.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import SosPresentationTimer from "./SosPresentationTimer";
import { COUNTDOWN_PHASE_MS, CYCLE_MS, TIMER_TOTAL_MS } from "./sosTimerModel";

const noChime = () => false;

function setup(props = {}) {
  const onClose = vi.fn();
  const utils = render(<SosPresentationTimer onClose={onClose} seed={7} chime={noChime} {...props} />);
  return { onClose, ...utils };
}

/** Moves both the interval and the mocked wall clock forward together. */
function advance(ms) {
  act(() => { vi.advanceTimersByTime(ms); });
}

/**
 * Moves the WALL CLOCK forward WITHOUT letting the interval fire — the exact
 * window between the target finish time passing and the tick that notices it.
 */
function skewClock(ms) {
  act(() => { vi.setSystemTime(Date.now() + ms); });
}

const clock = () => screen.getByTestId("sos-timer-clock").textContent;
const phase = () => screen.getByTestId("sos-timer").dataset.phase;
const status = () => screen.getByTestId("sos-timer").dataset.status;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete Element.prototype.requestFullscreen;
  delete document.exitFullscreen;
  Object.defineProperty(document, "fullscreenElement", {
    value: null, writable: true, configurable: true,
  });
});

describe("countdown", () => {
  test("starts from exactly 10:00 on the countdown phase", () => {
    setup();
    expect(clock()).toBe("10:00");
    expect(phase()).toBe("countdown");
    expect(status()).toBe("running");
  });

  test("counts down by real elapsed time, not by a fixed subtraction", () => {
    setup();
    advance(10_000);
    expect(clock()).toBe("09:50");
    // one long stall (a throttled tab) still lands on the true remaining time
    advance(110_000);
    expect(clock()).toBe("08:00");
  });

  test("keeps running while a message is displayed and returns with the true time", () => {
    setup();
    advance(COUNTDOWN_PHASE_MS); // 30s → message
    expect(phase()).toBe("message");
    expect(screen.getByTestId("sos-timer-message").textContent).not.toBe("");

    advance(CYCLE_MS - COUNTDOWN_PHASE_MS); // finish the message segment
    expect(phase()).toBe("countdown");
    // 42s of the ten minutes have really passed while the message was up
    expect(clock()).toBe("09:18");
  });

  test("consecutive cycles show different messages", () => {
    setup();
    advance(COUNTDOWN_PHASE_MS);
    const first = screen.getByTestId("sos-timer-message").textContent;
    advance(CYCLE_MS);
    const second = screen.getByTestId("sos-timer-message").textContent;
    expect(second).not.toBe(first);
    expect(second).not.toBe("");
  });
});

describe("controls", () => {
  test("pause freezes the remaining time and continue resumes accurately", () => {
    setup();
    advance(20_000);
    expect(clock()).toBe("09:40");

    fireEvent.click(screen.getByRole("button", { name: /Pauza/ }));
    expect(status()).toBe("paused");
    expect(screen.getByTestId("sos-timer-paused")).toBeInTheDocument();

    advance(60_000); // wall clock moves on; the timer must not
    expect(clock()).toBe("09:40");

    fireEvent.click(screen.getByRole("button", { name: /Davom etish/ }));
    expect(status()).toBe("running");
    advance(10_000);
    expect(clock()).toBe("09:30");
  });

  test("restart resets the countdown and the message cycle", () => {
    setup();
    advance(COUNTDOWN_PHASE_MS + 5_000);
    expect(phase()).toBe("message");

    fireEvent.click(screen.getByRole("button", { name: /Qaytadan/ }));
    expect(clock()).toBe("10:00");
    expect(phase()).toBe("countdown");
    expect(status()).toBe("running");

    advance(COUNTDOWN_PHASE_MS);
    // the cycle restarted, so this is the FIRST message of the sequence again
    expect(phase()).toBe("message");
  });

  test("restart works from the paused and finished states too", () => {
    setup({ totalMs: 5_000 });
    advance(6_000);
    expect(status()).toBe("finished");
    fireEvent.click(screen.getByRole("button", { name: /Qaytadan/ }));
    expect(status()).toBe("running");
    expect(clock()).toBe("00:05");
  });

  test("starting, pausing, resuming and restarting never stack a second interval", () => {
    setup();
    expect(vi.getTimerCount()).toBe(1);
    advance(5_000);
    expect(vi.getTimerCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Pauza/ }));
    expect(vi.getTimerCount()).toBe(0); // paused → nothing ticking
    fireEvent.click(screen.getByRole("button", { name: /Davom etish/ }));
    expect(vi.getTimerCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Qaytadan/ }));
    fireEvent.click(screen.getByRole("button", { name: /Qaytadan/ }));
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("pause after the countdown has already reached zero", () => {
  test("Pause between zero and the next tick finishes instead of freezing at 00:00", () => {
    setup({ totalMs: 60_000 });
    // The target finish instant passes, but no tick has run yet, so the timer is
    // still nominally running and Pause is still on screen.
    skewClock(61_000);
    expect(status()).toBe("running");
    fireEvent.click(screen.getByRole("button", { name: /Pauza/ }));

    expect(status()).toBe("finished");
    expect(clock()).toBe("00:00");
    expect(screen.getByTestId("sos-timer-done").textContent).toMatch(/Vaqt tugadi/);
    expect(screen.queryByTestId("sos-timer-paused")).toBeNull();
    // Nothing can resume a spent timer, and nothing is left ticking.
    expect(screen.queryByRole("button", { name: /Davom etish/ })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("the completion chime still fires on that path", () => {
    const chime = vi.fn();
    setup({ totalMs: 30_000, chime });
    skewClock(31_000);
    fireEvent.click(screen.getByRole("button", { name: /Pauza/ }));
    expect(chime).toHaveBeenCalledTimes(1);
  });

  test("landing exactly on zero also finishes rather than pausing", () => {
    setup({ totalMs: 20_000 });
    skewClock(20_000); // remaining is exactly 0
    fireEvent.click(screen.getByRole("button", { name: /Pauza/ }));
    expect(status()).toBe("finished");
    expect(clock()).toBe("00:00");
  });

  test("a genuine mid-run pause is unaffected and still resumes", () => {
    setup({ totalMs: 60_000 });
    advance(10_000);
    fireEvent.click(screen.getByRole("button", { name: /Pauza/ }));
    expect(status()).toBe("paused");
    expect(clock()).toBe("00:50");
    fireEvent.click(screen.getByRole("button", { name: /Davom etish/ }));
    expect(status()).toBe("running");
  });

  test("restart recovers from the finished-by-pause state", () => {
    setup({ totalMs: 60_000 });
    skewClock(61_000);
    fireEvent.click(screen.getByRole("button", { name: /Pauza/ }));
    expect(status()).toBe("finished");
    fireEvent.click(screen.getByRole("button", { name: /Qaytadan/ }));
    expect(status()).toBe("running");
    expect(clock()).toBe("01:00");
    advance(5_000);
    expect(clock()).toBe("00:55");
  });
});

describe("audio is primed from the user gesture", () => {
  test("Restart re-primes the audio context, since it is also a click", () => {
    const primeAudio = vi.fn();
    setup({ primeAudio });
    expect(primeAudio).not.toHaveBeenCalled(); // mounting is not a gesture
    fireEvent.click(screen.getByRole("button", { name: /Qaytadan/ }));
    expect(primeAudio).toHaveBeenCalledTimes(1);
    expect(status()).toBe("running");
    expect(clock()).toBe("10:00");
  });

  test("a throwing prime cannot stop the restart", () => {
    const primeAudio = vi.fn(() => { throw new Error("audio blocked"); });
    setup({ primeAudio, totalMs: 60_000 });
    advance(10_000);
    expect(() => fireEvent.click(screen.getByRole("button", { name: /Qaytadan/ }))).not.toThrow();
    expect(clock()).toBe("01:00");
    expect(status()).toBe("running");
  });
});

describe("StrictMode (how the app actually mounts in development)", () => {
  test("the double-invoked effects still leave exactly one interval", () => {
    render(
      <React.StrictMode>
        <SosPresentationTimer onClose={() => {}} seed={7} chime={noChime} />
      </React.StrictMode>,
    );
    expect(vi.getTimerCount()).toBe(1);
    advance(15_000);
    expect(vi.getTimerCount()).toBe(1);
    expect(screen.getByTestId("sos-timer-clock").textContent).toBe("09:45");
  });
});

describe("completion", () => {
  test("stops cleanly at 00:00 with the Uzbek completion message", () => {
    const chime = vi.fn();
    setup({ chime });
    advance(TIMER_TOTAL_MS + 1_000);
    expect(clock()).toBe("00:00");
    expect(status()).toBe("finished");
    expect(screen.getByTestId("sos-timer-done").textContent).toMatch(/Vaqt tugadi/);
    expect(chime).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); // no timer left running at zero
  });

  test("the completion state offers a way to restart and to close", () => {
    const { onClose } = setup({ totalMs: 2_000 });
    advance(3_000);
    expect(screen.getByRole("button", { name: /Qaytadan/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Chiqish/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a failing chime cannot break the completion state", () => {
    setup({ totalMs: 1_000, chime: () => { throw new Error("no audio"); } });
    expect(() => advance(2_000)).not.toThrow();
    expect(screen.getByTestId("sos-timer-done")).toBeInTheDocument();
  });
});

describe("fullscreen", () => {
  test("falls back to a full-window overlay when the API is unavailable", () => {
    setup();
    expect(screen.getByTestId("sos-timer").dataset.fullscreen).toBe("window");
  });

  test("falls back cleanly when the fullscreen request is DENIED", async () => {
    Element.prototype.requestFullscreen = vi.fn(() => Promise.reject(new Error("denied")));
    setup();
    await act(async () => {});
    expect(Element.prototype.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("sos-timer").dataset.fullscreen).toBe("window");
    // the countdown is unaffected by the rejection
    advance(5_000);
    expect(clock()).toBe("09:55");
  });

  test("uses real fullscreen when the request is granted", async () => {
    Element.prototype.requestFullscreen = vi.fn(() => Promise.resolve());
    setup();
    await act(async () => {});
    expect(screen.getByTestId("sos-timer").dataset.fullscreen).toBe("native");
  });

  test("leaving browser fullscreen keeps the timer running in the window", async () => {
    Element.prototype.requestFullscreen = vi.fn(() => Promise.resolve());
    setup();
    await act(async () => {});
    Object.defineProperty(document, "fullscreenElement", {
      value: null, writable: true, configurable: true,
    });
    act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
    expect(screen.getByTestId("sos-timer").dataset.fullscreen).toBe("window");
    expect(status()).toBe("running");
    advance(3_000);
    expect(clock()).toBe("09:57");
  });

  test("exiting releases fullscreen and closes", () => {
    Object.defineProperty(document, "fullscreenElement", {
      value: document.createElement("div"), writable: true, configurable: true,
    });
    document.exitFullscreen = vi.fn(() => Promise.resolve());
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Chiqish/ }));
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape closes the timer", () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("cleanup", () => {
  test("unmounting leaves no interval and no listener behind", () => {
    const { unmount } = setup();
    advance(1_000);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    // a stray Escape after unmount must not reach a removed handler
    expect(() => fireEvent.keyDown(document, { key: "Escape" })).not.toThrow();
  });
});

describe("TEST mode", () => {
  test("the TEST marker stays visible while the timer runs", () => {
    setup({ isTest: true });
    expect(screen.getByTestId("sos-timer-test-badge").textContent).toMatch(/TEST/);
    advance(COUNTDOWN_PHASE_MS + 2_000);
    expect(phase()).toBe("message");
    expect(screen.getByTestId("sos-timer-test-badge")).toBeInTheDocument();
    advance(TIMER_TOTAL_MS);
    expect(screen.getByTestId("sos-timer-test-badge")).toBeInTheDocument();
  });

  test("the real presentation carries no TEST marker", () => {
    setup({ isTest: false });
    expect(screen.queryByTestId("sos-timer-test-badge")).toBeNull();
  });
});
