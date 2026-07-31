/**
 * The completion chime under strict autoplay rules.
 *
 * The real failure this guards: an AudioContext created ten minutes after the
 * last click starts `suspended` and plays nothing. `primeChimeAudio()` must
 * create and resume the context inside the starting gesture, and
 * `playCompletionChime()` must then reuse that same running context — without
 * creating a new one each time (browsers cap contexts per page) and without ever
 * closing it (a later restart still needs it).
 *
 * A fake AudioContext stands in for the browser's, so the autoplay state machine
 * is asserted directly rather than inferred.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import playCompletionChime, { primeChimeAudio, resetChimeAudioForTests } from "./sosTimerChime";

let created;

/** Mimics a strict-autoplay browser: a fresh context starts suspended. */
function installFakeAudio({ resumeRejects = false, constructorThrows = false } = {}) {
  created = [];
  class FakeAudioContext {
    constructor() {
      if (constructorThrows) throw new Error("blocked by policy");
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = { kind: "destination" };
      this.scheduled = [];
      this.closed = false;
      created.push(this);
    }
    resume() {
      if (resumeRejects) return Promise.reject(new Error("refused"));
      this.state = "running";
      return Promise.resolve();
    }
    close() { this.closed = true; this.state = "closed"; return Promise.resolve(); }
    createOscillator() {
      const node = {
        type: "", frequency: { value: 0 },
        connect: (next) => next,
        start: (at) => this.scheduled.push({ kind: "start", at }),
        stop: (at) => this.scheduled.push({ kind: "stop", at }),
      };
      return node;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: (next) => next,
      };
    }
  }
  window.AudioContext = FakeAudioContext;
}

beforeEach(() => {
  resetChimeAudioForTests();
  created = [];
});
afterEach(() => {
  delete window.AudioContext;
  delete window.webkitAudioContext;
  resetChimeAudioForTests();
  vi.restoreAllMocks();
});

describe("priming from the start click", () => {
  test("creates the context and resumes it out of the suspended state", () => {
    installFakeAudio();
    expect(primeChimeAudio()).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].state).toBe("running");
  });

  test("the chime reuses the primed context instead of making another", () => {
    installFakeAudio();
    primeChimeAudio();
    expect(playCompletionChime()).toBe(true);
    expect(created).toHaveLength(1); // no second context
    expect(created[0].state).toBe("running");
    // two notes, each with a start and a stop
    expect(created[0].scheduled.filter((s) => s.kind === "start")).toHaveLength(2);
    expect(created[0].scheduled.filter((s) => s.kind === "stop")).toHaveLength(2);
  });

  test("the context is never closed, so a later restart can chime again", () => {
    installFakeAudio();
    primeChimeAudio();
    playCompletionChime();
    expect(created[0].closed).toBe(false);
    primeChimeAudio(); // restart is a gesture too
    expect(playCompletionChime()).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].scheduled.filter((s) => s.kind === "start")).toHaveLength(4);
  });

  test("priming repeatedly does not stack contexts", () => {
    installFakeAudio();
    primeChimeAudio();
    primeChimeAudio();
    primeChimeAudio();
    expect(created).toHaveLength(1);
  });

  test("a context suspended again by a backgrounded tab is resumed at 00:00", () => {
    installFakeAudio();
    primeChimeAudio();
    created[0].state = "suspended"; // the browser suspended it while idle
    expect(playCompletionChime()).toBe(true);
    expect(created[0].state).toBe("running");
  });
});

describe("audio unavailable — the timer must still finish", () => {
  test("no AudioContext at all: both calls report false and never throw", () => {
    delete window.AudioContext;
    delete window.webkitAudioContext;
    expect(primeChimeAudio()).toBe(false);
    expect(playCompletionChime()).toBe(false);
  });

  test("a constructor that throws is swallowed", () => {
    installFakeAudio({ constructorThrows: true });
    expect(primeChimeAudio()).toBe(false);
    expect(playCompletionChime()).toBe(false);
  });

  test("a refused resume never surfaces an unhandled rejection", async () => {
    installFakeAudio({ resumeRejects: true });
    expect(primeChimeAudio()).toBe(true);
    expect(playCompletionChime()).toBe(true); // notes are still scheduled
    await Promise.resolve();
    expect(created[0].state).toBe("suspended"); // simply stayed silent
  });

  test("the chime works without priming, for browsers that allow it", () => {
    installFakeAudio();
    expect(playCompletionChime()).toBe(true);
    expect(created).toHaveLength(1);
  });

  test("a webkit-prefixed context is used when that is all there is", () => {
    installFakeAudio();
    window.webkitAudioContext = window.AudioContext;
    delete window.AudioContext;
    expect(primeChimeAudio()).toBe(true);
    expect(created).toHaveLength(1);
  });
});
