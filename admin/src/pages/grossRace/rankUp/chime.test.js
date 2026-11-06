/**
 * The climb chime: three tones when the browser lets the page make a sound,
 * a quiet false when it does not — never an error, never a late chime.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { RESUME_TIMEOUT_MS, playChime, resetChime } from "./chime";

function fakeContext({ state = "running", resume } = {}) {
  const made = [];
  const param = () => ({ setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  class Ctx {
    constructor() {
      this.state = state;
      this.currentTime = 10;
      this.destination = {};
      this.resume = resume ? vi.fn(() => resume(this)) : undefined;
    }

    createOscillator() {
      const osc = { frequency: param(), connect: vi.fn(), start: vi.fn(), stop: vi.fn(), type: null };
      made.push(osc);
      return osc;
    }

    createGain() { return { gain: param(), connect: vi.fn() }; }
  }
  return { Ctx, made };
}

afterEach(() => {
  resetChime();
  vi.useRealTimers();
});

describe("playChime", () => {
  test("a running context: three tones, high to low", async () => {
    const { Ctx, made } = fakeContext();
    expect(await playChime({ AudioContextImpl: Ctx })).toBe(true);
    expect(made).toHaveLength(3);
    const hz = made.map((osc) => osc.frequency.setValueAtTime.mock.calls[0][0]);
    expect(hz[0]).toBeGreaterThan(hz[1]);
    expect(hz[1]).toBeGreaterThan(hz[2]);
    for (const osc of made) expect(osc.start).toHaveBeenCalled();
  });

  test("a suspended context the browser lets resume plays", async () => {
    const { Ctx, made } = fakeContext({ state: "suspended", resume: async (ctx) => { ctx.state = "running"; } });
    expect(await playChime({ AudioContextImpl: Ctx })).toBe(true);
    expect(made).toHaveLength(3);
  });

  test("a browser that refuses to resume: false, and nothing is scheduled", async () => {
    const refused = Object.assign(new Error("no"), { name: "NotAllowedError" });
    const { Ctx, made } = fakeContext({ state: "suspended", resume: async () => { throw refused; } });
    expect(await playChime({ AudioContextImpl: Ctx })).toBe(false);
    expect(made).toHaveLength(0);
  });

  test("a resume that never answers: false after a moment, and a late answer releases no chime", async () => {
    vi.useFakeTimers();
    let release;
    const { Ctx, made } = fakeContext({ state: "suspended", resume: (ctx) => new Promise((resolve) => { release = () => { ctx.state = "running"; resolve(); }; }) });
    const played = playChime({ AudioContextImpl: Ctx });
    await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS);
    expect(await played).toBe(false);
    release();
    await Promise.resolve();
    expect(made).toHaveLength(0);
  });

  test("no Web Audio at all, or a context that throws: false, never an error", async () => {
    expect(await playChime({ AudioContextImpl: null })).toBe(false);
    resetChime();
    class Broken { constructor() { throw new Error("no audio device"); } }
    expect(await playChime({ AudioContextImpl: Broken })).toBe(false);
  });
});
