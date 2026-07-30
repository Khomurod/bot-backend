/**
 * The 10-minute SOS presentation countdown as a hook.
 *
 * Exactly ONE interval exists while the timer runs: it lives in a single effect
 * keyed by (status, runId), so re-renders, repeated starts and restarts can
 * never stack a second ticker. Pausing clears it; resuming re-arms it against a
 * freshly computed finish instant, so the remaining time survives the pause
 * exactly. Unmounting clears it too — nothing keeps running behind a closed
 * timer.
 *
 * A tick only READS the clock (`endsAt - Date.now()`); see sosTimerModel.js for
 * why the value is never accumulated.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildMessageSequence } from "./sosTimerMessages";
import { TIMER_TOTAL_MS, messageSlotCount, phaseAt, remainingFraction } from "./sosTimerModel";

const DEFAULT_TICK_MS = 200;

export default function useSosTimer({
  totalMs = TIMER_TOTAL_MS,
  seed,
  tickMs = DEFAULT_TICK_MS,
  onFinish,
} = {}) {
  const [status, setStatus] = useState("running"); // running | paused | finished
  const [remainingMs, setRemainingMs] = useState(totalMs);
  const [runId, setRunId] = useState(0);

  const endsAtRef = useRef(null); // target finish instant while running
  const remainingRef = useRef(totalMs); // authoritative while paused
  const statusRef = useRef(status);
  statusRef.current = status;
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  // Stable for the lifetime of the timer: the message order must not change on
  // every render, and a restart must replay the SAME deterministic sequence.
  const seedRef = useRef(seed == null ? Date.now() : seed);
  const messages = useMemo(
    () => buildMessageSequence(messageSlotCount(totalMs), seedRef.current),
    [totalMs],
  );

  useEffect(() => {
    if (status !== "running") return undefined;
    if (endsAtRef.current == null) endsAtRef.current = Date.now() + remainingRef.current;
    const tick = () => {
      const left = Math.max(0, endsAtRef.current - Date.now());
      remainingRef.current = left;
      setRemainingMs(left);
      if (left <= 0) setStatus("finished");
    };
    tick();
    const id = setInterval(tick, tickMs);
    return () => clearInterval(id);
  }, [status, runId, tickMs]);

  useEffect(() => {
    if (status === "finished" && finishRef.current) finishRef.current();
  }, [status]);

  // Guarded through a ref rather than a setStatus updater: the updater must stay
  // pure (React may call it twice), and these transitions also move the refs.
  const pause = useCallback(() => {
    if (statusRef.current !== "running") return;
    const left = Math.max(0, (endsAtRef.current ?? Date.now()) - Date.now());
    remainingRef.current = left;
    endsAtRef.current = null;
    setRemainingMs(left);
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    if (statusRef.current !== "paused") return;
    endsAtRef.current = Date.now() + remainingRef.current;
    setStatus("running");
  }, []);

  const restart = useCallback(() => {
    remainingRef.current = totalMs;
    endsAtRef.current = Date.now() + totalMs;
    setRemainingMs(totalMs);
    setStatus("running");
    setRunId((n) => n + 1); // re-arms the single interval even if already running
  }, [totalMs]);

  const elapsedMs = totalMs - remainingMs;
  const { phase, cycleIndex } = phaseAt(elapsedMs);
  const finished = status === "finished";

  return {
    status,
    finished,
    remainingMs,
    elapsedMs,
    // At 00:00 neither layer cycles any more: the completion state owns the screen.
    phase: finished ? "finished" : phase,
    message: messages[cycleIndex % messages.length] || "",
    messages,
    remainingFraction: remainingFraction(remainingMs, totalMs),
    pause,
    resume,
    restart,
  };
}
