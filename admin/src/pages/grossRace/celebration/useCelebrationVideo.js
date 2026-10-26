import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The video after the 4 PM celebration, on /dispatchteam only (the owner,
 * 16 October 2026). While the car is on screen the video is fetched out of
 * sight ("ready"), so it can start the moment the car is gone ("playing");
 * then the board is back.
 *
 * Only a celebration that is not a sound test leads to it, and only when the
 * server has a video (`available`). `active` is a ref so the page's reload
 * check never reloads the screen in the middle of it.
 *
 * When the server stops saying there is one — paused or deleted in Settings →
 * Gross Grand Prix — a video waiting or playing is closed on that poll and the
 * board is back (the owner, 26 October 2026: pausing has to stop it on screen).
 */
export default function useCelebrationVideo({ enabled, available, celebration, testing }) {
  const [stage, setStage] = useState(null); // null | "ready" | "playing"
  const active = useRef(false);
  const handled = useRef(null); // the celebration already decided on: once each

  useEffect(() => {
    if (celebration) {
      if (handled.current === celebration) return;
      handled.current = celebration;
      if (enabled && available && !(testing && testing.current)) {
        active.current = true;
        setStage("ready");
      }
    } else if (stage === "ready") {
      setStage("playing");
    }
  }, [celebration, stage, enabled, available, testing]);

  const done = useCallback(() => {
    active.current = false;
    setStage(null);
  }, []);

  useEffect(() => {
    if (!available && stage) done();
  }, [available, stage, done]);

  return { stage, active, done };
}
