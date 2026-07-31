/**
 * A single gentle two-note chime for the moment the SOS timer reaches 00:00.
 *
 * Entirely optional and fully guarded: the Web Audio API is generated on the
 * spot (no asset to ship, nothing to preload), the whole call is wrapped so a
 * missing AudioContext, a browser autoplay policy or a closed context can never
 * break the timer, and the gain envelope is deliberately quiet with a soft
 * attack/release so it reads as a soft "ding" in a meeting room rather than an
 * alarm. If anything is unavailable the timer simply finishes silently.
 */

const NOTES = [
  { frequency: 880, startAt: 0 }, // A5
  { frequency: 1174.66, startAt: 0.28 }, // D6
];
const NOTE_LENGTH_S = 0.75;
const PEAK_GAIN = 0.12; // intentionally low

export default function playCompletionChime() {
  try {
    const AudioCtx = typeof window !== "undefined"
      && (window.AudioContext || window.webkitAudioContext);
    if (!AudioCtx) return false;
    const ctx = new AudioCtx();
    const start = ctx.currentTime + 0.02;
    for (const note of NOTES) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = note.frequency;
      const noteStart = start + note.startAt;
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, noteStart + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + NOTE_LENGTH_S);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + NOTE_LENGTH_S + 0.05);
    }
    const totalMs = (NOTES[NOTES.length - 1].startAt + NOTE_LENGTH_S + 0.3) * 1000;
    setTimeout(() => { try { ctx.close(); } catch (_) { /* already closed */ } }, totalMs);
    return true;
  } catch (_) {
    return false; // never let presentation audio break the countdown
  }
}
