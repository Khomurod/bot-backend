import { useCallback, useEffect, useRef, useState } from "react";
import { probeAutoplay } from "./autoplayProbe";
import { CELEBRATION_MS, celebrationWinner } from "../celebration/celebrationTime";

/** Who the test celebrates while nobody has any gross yet. */
export const TEST_WINNER = { id: "sound-test", name: "Sound test", gross: 0 };

/**
 * The board's "Test sound" button (the owner, 16 October 2026): one press on
 * the TV runs what 4 PM will run, the celebration and then a clip with sound,
 * and ends on a card of what this screen can do (SoundTestOverlay).
 *
 * `autoplay` is the page-load probe's answer, asked before anybody presses
 * anything. `active` is a ref so the page's reload check, which runs in the
 * same pass as a press, never reloads the screen in the middle of a test.
 */
export default function useSoundTest({ race, celebration, setCelebration, probe = probeAutoplay }) {
  const [autoplay, setAutoplay] = useState("checking");
  const [test, setTest] = useState(null); // { stage: "car" | "video", car: null | "on" | "off" }
  const active = useRef(false);

  useEffect(() => {
    let gone = false;
    probe().then(
      (answer) => { if (!gone) setAutoplay(answer); },
      () => { if (!gone) setAutoplay("unknown"); },
    );
    return () => { gone = true; };
  }, [probe]);

  const start = useCallback(() => {
    if (active.current) return;
    active.current = true;
    setTest({ stage: "car", car: null });
    setCelebration({ winner: celebrationWinner(race) || TEST_WINNER, until: Date.now() + CELEBRATION_MS });
  }, [race, setCelebration]);

  // The celebration on screen, then over: on to the clip. Over only once it
  // was seen, so the pass that starts the test does not skip it.
  const shown = useRef(false);
  useEffect(() => {
    if (!test || test.stage !== "car") { shown.current = false; return; }
    if (celebration) shown.current = true;
    else if (shown.current) setTest((held) => held && { ...held, stage: "video" });
  }, [celebration, test]);

  const noteCar = useCallback((car) => {
    setTest((held) => (held && held.stage === "car" ? { ...held, car } : held));
  }, []);

  const close = useCallback(() => {
    active.current = false;
    setTest(null);
  }, []);

  return { autoplay, test, active, start, noteCar, close };
}
