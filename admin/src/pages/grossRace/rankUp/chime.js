/**
 * The airport "ding-dong" for a climb on the race board (the owner,
 * 6 November 2026): three soft tones, about a second and a half, made on the
 * screen with Web Audio — no sound file.
 *
 * The browser decides whether a page may make a sound nobody clicked for. An
 * office screen allows it only when Chrome was started with
 * `--autoplay-policy=no-user-gesture-required` (Settings → Gross Grand Prix
 * says how). Where it is not allowed, `resume()` is refused or the context
 * stays suspended: the chime answers false and the card shows without it.
 * Nothing here ever throws.
 */
const TONES = [
  { hz: 783.99, at: 0, length: 0.55 }, // G5
  { hz: 659.25, at: 0.45, length: 0.55 }, // E5
  { hz: 523.25, at: 0.9, length: 0.7 }, // C5
];

/** A browser that will not resume without a click may leave `resume()` unanswered: give up after this. */
export const RESUME_TIMEOUT_MS = 500;

let context = null;

function contextFrom(Impl) {
  if (context) return context;
  const Ctor = Impl || (typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext));
  if (!Ctor) return null;
  context = new Ctor();
  return context;
}

/** For tests: forget the context so the next chime makes a new one. */
export function resetChime() {
  context = null;
}

/**
 * @param {object} [options]
 * @param {Function} [options.AudioContextImpl]  injected for tests
 * @returns {Promise<boolean>} true when the tones were scheduled
 */
export async function playChime({ AudioContextImpl } = {}) {
  try {
    const ctx = contextFrom(AudioContextImpl);
    if (!ctx) return false;
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      // Never wait on an unanswered resume: a click later would release a chime
      // nobody asked for at that moment.
      let timer;
      const late = new Promise((resolve) => { timer = setTimeout(resolve, RESUME_TIMEOUT_MS); });
      await Promise.race([Promise.resolve(ctx.resume()).catch(() => {}), late]);
      clearTimeout(timer);
    }
    if (ctx.state !== "running") return false;
    const start = ctx.currentTime + 0.05;
    for (const tone of TONES) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(tone.hz, start + tone.at);
      gain.gain.setValueAtTime(0.0001, start + tone.at);
      gain.gain.exponentialRampToValueAtTime(0.35, start + tone.at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.at + tone.length);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start + tone.at);
      osc.stop(start + tone.at + tone.length + 0.05);
    }
    return true;
  } catch {
    return false;
  }
}
