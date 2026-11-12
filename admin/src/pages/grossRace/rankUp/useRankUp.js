import { useCallback, useEffect, useRef, useState } from "react";
import { pickRankUp } from "./pickRankUp";
import { playChime } from "./chime";
import { probeAutoplay } from "../soundTest/autoplayProbe";

/** How long the card stays on screen. */
export const RANK_UP_MS = 7000;

/** Who the dispatchers' Test sound shows climbing. */
export const TEST_CLIMB = { name: "Sound test", rank: 3, from: 5, passed: "", leader: false, test: true };

/**
 * The chime and the big card when a racer climbs (the owner, 6 November 2026),
 * on both boards.
 *
 * `offer(events, now)` is called with each reading's events. It stands down
 * while something more important holds the screen — the 4 PM celebration, the
 * video, the sound test (`isBusy`) — and the climb stays in the feed. `showing`
 * is a ref so the page's reload check, which runs in the same pass, sees a
 * card the moment it is set. Both boards show everybody on one screen, so the
 * climber is always in view.
 *
 * `offer` and `test` keep their identity across renders (the page's reading
 * callback depends on them), so `isBusy` is read through a ref.
 */
export default function useRankUp({
  isBusy = () => false, probe = probeAutoplay, chime = playChime, probeOnLoad = false,
}) {
  const [card, setCard] = useState(null);
  const [autoplay, setAutoplay] = useState("checking");
  const showing = useRef(false);
  const lastShownAt = useRef(null);
  const busy = useRef(isBusy);
  busy.current = isBusy;

  useEffect(() => {
    if (!probeOnLoad) return undefined;
    let gone = false;
    Promise.resolve().then(probe).then(
      (answer) => { if (!gone) setAutoplay(answer || "unknown"); },
      () => { if (!gone) setAutoplay("unknown"); },
    );
    return () => { gone = true; };
  }, [probe, probeOnLoad]);

  const show = useCallback((next, now) => {
    const until = now + RANK_UP_MS;
    showing.current = true;
    setCard({ ...next, until });
    Promise.resolve().then(() => chime()).then(
      (played) => setCard((held) => (held && held.until === until ? { ...held, chimed: Boolean(played) } : held)),
      () => setCard((held) => (held && held.until === until ? { ...held, chimed: false } : held)),
    );
  }, [chime]);

  const offer = useCallback((events, now = Date.now()) => {
    if (showing.current || busy.current()) return null;
    const pick = pickRankUp(events, lastShownAt.current, now);
    if (!pick) return null;
    lastShownAt.current = now;
    show(pick, now);
    return pick;
  }, [show]);

  /** The Test sound button on /dispatch: the card and the chime, and whether sound may start by itself. */
  const test = useCallback(() => {
    if (showing.current || busy.current()) return;
    show(TEST_CLIMB, Date.now());
  }, [show]);

  /** A new week is a new race: last week's climb goes with it. */
  const clear = useCallback(() => {
    showing.current = false;
    lastShownAt.current = null;
    setCard(null);
  }, []);

  const tick = useCallback((now) => {
    if (card && now >= card.until) {
      showing.current = false;
      setCard(null);
    }
  }, [card]);

  return {
    card: card ? { ...card, autoplay } : null, showing, offer, test, tick, clear, autoplay,
  };
}
