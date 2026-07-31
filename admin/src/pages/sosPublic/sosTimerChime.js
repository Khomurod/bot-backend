/**
 * A single gentle two-note chime for the moment the SOS timer reaches 00:00.
 *
 * AUTOPLAY: browsers with strict autoplay rules only allow an AudioContext to
 * start inside a user gesture. Ten minutes later, at 00:00, there is no gesture
 * — so a context created then starts `suspended` and the chime is silent.
 * `primeChimeAudio()` is therefore called from the ORIGINAL click that starts
 * the timer (and again from Restart, which is also a click): it creates and
 * resumes the context while the gesture is still in scope, and
 * `playCompletionChime()` reuses that already-running context at 00:00.
 *
 * ONE OWNER: this module owns the single shared AudioContext for the page. It is
 * deliberately never closed — closing it would make a later restart silent, and
 * one long-lived context also avoids the per-page context limit that creating a
 * fresh context on every completion used to walk into.
 *
 * Everything is optional and fully guarded: no AudioContext, a refused resume,
 * or a throwing node graph can never affect the countdown. The timer finishes
 * normally, just silently.
 */

const NOTES = [
  { frequency: 880, startAt: 0 }, // A5
  { frequency: 1174.66, startAt: 0.28 }, // D6
];
const NOTE_LENGTH_S = 0.75;
const PEAK_GAIN = 0.12; // intentionally low

let sharedContext = null;

function audioContextConstructor() {
  if (typeof window === "undefined") return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

/** Resumes a suspended context without ever surfacing a rejection. */
function resumeQuietly(context) {
  if (!context || context.state !== "suspended" || typeof context.resume !== "function") return;
  try {
    const resumed = context.resume();
    if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
  } catch (_) { /* the browser refused — stay silent */ }
}

/**
 * Called from the user gesture that starts (or restarts) the timer. Creates the
 * shared context if needed and resumes it, so the chime can play later without a
 * gesture of its own. Returns whether a context is available at all.
 */
export function primeChimeAudio() {
  try {
    const AudioCtx = audioContextConstructor();
    if (!AudioCtx) return false;
    if (!sharedContext || sharedContext.state === "closed") sharedContext = new AudioCtx();
    resumeQuietly(sharedContext);
    return true;
  } catch (_) {
    sharedContext = null;
    return false;
  }
}

/**
 * Plays the completion chime through the primed context. Falls back to creating
 * one (some browsers do allow it) so a timer that was never primed can still
 * chime; returns false when no sound was scheduled.
 */
export default function playCompletionChime() {
  try {
    if (!sharedContext || sharedContext.state === "closed") {
      if (!primeChimeAudio()) return false;
    }
    const context = sharedContext;
    if (!context) return false;
    resumeQuietly(context); // a backgrounded tab may have suspended it again

    const start = context.currentTime + 0.02;
    for (const note of NOTES) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = note.frequency;
      const noteStart = start + note.startAt;
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, noteStart + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + NOTE_LENGTH_S);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + NOTE_LENGTH_S + 0.05);
    }
    return true;
  } catch (_) {
    return false; // never let presentation audio break the countdown
  }
}

/** Test seam: forgets the shared context so each case starts clean. */
export function resetChimeAudioForTests() {
  sharedContext = null;
}
