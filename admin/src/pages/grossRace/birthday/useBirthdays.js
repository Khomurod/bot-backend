import { useCallback, useRef, useState } from "react";
import { BIRTHDAY_MS, markShown, nextBirthday, readShown } from "./birthdayQueue";
import { tabStorage } from "../pageVersion";

/**
 * Today's birthdays on the board, one after another (birthdayQueue.js).
 *
 * `tick(birthdays, now)` runs every second: it ends the one on screen when its
 * time is up and starts the next when nothing more important holds the screen
 * (`isBusy`: the 4 PM celebration, the video, the sound test, a climb card —
 * the birthday waits for them). `active` is a ref so the reload check and the
 * climb card, which run in the same pass, see a birthday the moment it starts.
 */
export default function useBirthdays({ isBusy = () => false, storage = tabStorage() } = {}) {
  const [current, setCurrent] = useState(null);
  const active = useRef(false);
  const shown = useRef(null);
  const busy = useRef(isBusy);
  busy.current = isBusy;

  const tick = useCallback((birthdays, now) => {
    if (active.current) {
      if (current && now >= current.until) {
        active.current = false;
        setCurrent(null);
      }
      return;
    }
    if (!birthdays || !birthdays.length || busy.current()) return;
    if (!shown.current) shown.current = readShown(storage);
    const next = nextBirthday(birthdays, shown.current);
    if (!next) return;
    markShown(storage, shown.current, next.key);
    active.current = true;
    setCurrent({ ...next, until: now + BIRTHDAY_MS });
  }, [current, storage]);

  return { current, active, tick };
}
