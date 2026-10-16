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

  return { stage, active, done };
}
