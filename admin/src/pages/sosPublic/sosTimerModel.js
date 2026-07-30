/**
 * Pure timing model for the 10-minute SOS presentation timer.
 *
 * The displayed time is ALWAYS derived from a target finish instant
 * (`endsAt - now`), never accumulated by subtracting a fixed interval from a
 * previous value. That is what keeps the clock honest when the browser throttles
 * a background tab, a repaint is late, or a message fade runs long: a delayed
 * tick shows the true remaining time instead of drifting behind.
 *
 * The countdown/message cycle is derived the same way — a pure function of
 * elapsed time — so it cannot desynchronise from the clock and needs no timers
 * of its own.
 */

export const TIMER_TOTAL_MS = 10 * 60 * 1000; // exactly 10:00
export const COUNTDOWN_PHASE_MS = 30 * 1000; // large countdown ≈30s
export const MESSAGE_PHASE_MS = 12 * 1000; // one SOS message ≈10–15s
export const CYCLE_MS = COUNTDOWN_PHASE_MS + MESSAGE_PHASE_MS;
export const FADE_MS = 600; // must match the .sos-timer-layer CSS transition

/** mm:ss, minutes zero-padded so the projector text does not change width. */
export function formatClock(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Which layer is on screen at `elapsedMs`, and which cycle we are in.
 * `cycleIndex` doubles as the index into the message sequence.
 */
export function phaseAt(elapsedMs) {
  const elapsed = Math.max(0, elapsedMs);
  const cycleIndex = Math.floor(elapsed / CYCLE_MS);
  const withinCycle = elapsed - cycleIndex * CYCLE_MS;
  return withinCycle < COUNTDOWN_PHASE_MS
    ? { phase: "countdown", cycleIndex, withinPhaseMs: withinCycle }
    : { phase: "message", cycleIndex, withinPhaseMs: withinCycle - COUNTDOWN_PHASE_MS };
}

/** How many message slots a full run can consume (one per cycle, plus slack). */
export function messageSlotCount(totalMs = TIMER_TOTAL_MS) {
  return Math.ceil(totalMs / CYCLE_MS) + 1;
}

/** Fraction of the ten minutes still remaining, for the progress indicator. */
export function remainingFraction(remainingMs, totalMs = TIMER_TOTAL_MS) {
  if (!(totalMs > 0)) return 0;
  return Math.min(1, Math.max(0, remainingMs / totalMs));
}
