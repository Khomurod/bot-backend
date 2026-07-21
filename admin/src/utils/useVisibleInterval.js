import { useEffect, useRef } from "react";

/**
 * A setInterval that SKIPS ticks while the browser tab is hidden and fires the
 * callback once immediately when the tab becomes visible again.
 *
 * Why: a dashboard left open in a background tab (or on a laptop that is asleep
 * behind other windows) otherwise polls the backend — and therefore the
 * database — every few seconds forever. On a small dataset that repeated read
 * traffic is the dominant, avoidable source of Supabase egress. Pausing while
 * hidden cuts that to zero without changing the live experience: when the user
 * returns to the tab they get an immediate refresh.
 *
 * The callback is held in a ref so a new closure on each render never re-arms
 * the timer. Pass `enabled=false` (or intervalMs falsy) to disable entirely.
 */
export default function useVisibleInterval(callback, intervalMs, enabled = true) {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    if (!enabled || !intervalMs) return undefined;
    const isHidden = () => typeof document !== "undefined" && document.hidden;
    const tick = () => { if (!isHidden()) saved.current(); };
    const onVisible = () => { if (!isHidden()) saved.current(); };
    const timer = setInterval(tick, intervalMs);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [intervalMs, enabled]);
}
