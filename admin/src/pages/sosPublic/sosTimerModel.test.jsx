/**
 * The pure half of the SOS presentation timer: clock formatting, the
 * countdown/message cycle derivation, the progress fraction, and the Uzbek
 * message sequence (content rules, determinism, no back-to-back repeats).
 */
import { describe, expect, test } from "vitest";
import {
  COUNTDOWN_PHASE_MS, CYCLE_MS, MESSAGE_PHASE_MS, TIMER_TOTAL_MS,
  formatClock, messageSlotCount, phaseAt, remainingFraction,
} from "./sosTimerModel";
import { SOS_TIMER_MESSAGES, buildMessageSequence } from "./sosTimerMessages";

describe("clock", () => {
  test("a fresh timer reads exactly 10:00", () => {
    expect(TIMER_TOTAL_MS).toBe(600_000);
    expect(formatClock(TIMER_TOTAL_MS)).toBe("10:00");
  });

  test("formats the remaining time and never goes below 00:00", () => {
    expect(formatClock(599_000)).toBe("09:59");
    expect(formatClock(61_000)).toBe("01:01");
    expect(formatClock(1)).toBe("00:01");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(-5_000)).toBe("00:00");
  });
});

describe("countdown / message cycle", () => {
  test("each cycle shows the countdown first, then one message", () => {
    expect(COUNTDOWN_PHASE_MS).toBe(30_000);
    expect(MESSAGE_PHASE_MS).toBeGreaterThanOrEqual(10_000);
    expect(MESSAGE_PHASE_MS).toBeLessThanOrEqual(15_000);
    expect(CYCLE_MS).toBe(COUNTDOWN_PHASE_MS + MESSAGE_PHASE_MS);
  });

  test("phase transitions follow elapsed time, and the cycle repeats", () => {
    expect(phaseAt(0)).toMatchObject({ phase: "countdown", cycleIndex: 0 });
    expect(phaseAt(29_999).phase).toBe("countdown");
    expect(phaseAt(COUNTDOWN_PHASE_MS)).toMatchObject({ phase: "message", cycleIndex: 0 });
    expect(phaseAt(CYCLE_MS - 1).phase).toBe("message");
    // back to the countdown, with the true remaining time, in the next cycle
    expect(phaseAt(CYCLE_MS)).toMatchObject({ phase: "countdown", cycleIndex: 1 });
    expect(phaseAt(CYCLE_MS + COUNTDOWN_PHASE_MS)).toMatchObject({ phase: "message", cycleIndex: 1 });
    expect(phaseAt(5 * CYCLE_MS + 10)).toMatchObject({ phase: "countdown", cycleIndex: 5 });
  });

  test("a negative or throttled elapsed value cannot break the derivation", () => {
    expect(phaseAt(-1_000)).toMatchObject({ phase: "countdown", cycleIndex: 0 });
  });

  test("a full run has a message slot for every cycle", () => {
    expect(messageSlotCount(TIMER_TOTAL_MS)).toBeGreaterThanOrEqual(
      Math.ceil(TIMER_TOTAL_MS / CYCLE_MS),
    );
  });
});

describe("progress indicator", () => {
  test("reports the fraction of the ten minutes still left, clamped", () => {
    expect(remainingFraction(TIMER_TOTAL_MS)).toBe(1);
    expect(remainingFraction(TIMER_TOTAL_MS / 2)).toBeCloseTo(0.5);
    expect(remainingFraction(0)).toBe(0);
    expect(remainingFraction(-10)).toBe(0);
    expect(remainingFraction(TIMER_TOTAL_MS * 2)).toBe(1);
  });
});

describe("Uzbek SOS messages", () => {
  test("there are 10–12 distinct short messages", () => {
    expect(SOS_TIMER_MESSAGES.length).toBeGreaterThanOrEqual(10);
    expect(SOS_TIMER_MESSAGES.length).toBeLessThanOrEqual(12);
    expect(new Set(SOS_TIMER_MESSAGES).size).toBe(SOS_TIMER_MESSAGES.length);
  });

  test("every message is short, single-sentence-scale, and Uzbek-only", () => {
    for (const message of SOS_TIMER_MESSAGES) {
      expect(message.length).toBeGreaterThan(20);
      expect(message.length).toBeLessThanOrEqual(95); // presentation-friendly
      expect(message).not.toMatch(/[Ѐ-ӿ]/); // no Cyrillic (no Russian source text)
      expect(message).not.toMatch(/\n/);
    }
  });

  test("the same seed always produces the same order", () => {
    expect(buildMessageSequence(20, 7)).toEqual(buildMessageSequence(20, 7));
  });

  test("different seeds vary the order", () => {
    expect(buildMessageSequence(12, 1)).not.toEqual(buildMessageSequence(12, 99));
  });

  test("no message is ever shown twice in a row, across block boundaries", () => {
    for (const seed of [1, 2, 3, 42, 2026]) {
      const sequence = buildMessageSequence(60, seed);
      expect(sequence).toHaveLength(60);
      for (let i = 1; i < sequence.length; i += 1) {
        expect(sequence[i]).not.toBe(sequence[i - 1]);
      }
    }
  });

  test("every message is used once per round before any repeats", () => {
    const round = buildMessageSequence(SOS_TIMER_MESSAGES.length, 5);
    expect(new Set(round).size).toBe(SOS_TIMER_MESSAGES.length);
  });

  test("degenerate inputs return an empty sequence instead of looping", () => {
    expect(buildMessageSequence(0, 1)).toEqual([]);
    expect(buildMessageSequence(5, 1, [])).toEqual([]);
  });
});
