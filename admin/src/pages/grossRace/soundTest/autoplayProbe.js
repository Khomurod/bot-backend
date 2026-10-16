/**
 * Whether this screen's browser lets the page start a video WITH SOUND without
 * anybody clicking: the question the planned 4 PM video depends on (the owner,
 * 16 October 2026). The office screens are Smart TVs whose built-in browsers
 * each have their own rule, so the page asks its own browser.
 *
 * It asks once, when the page opens, with a quarter of a second of silence:
 * the answer costs nothing anybody can hear.
 */
export const PROBE_TIMEOUT_MS = 3000;

/** A WAV file of `seconds` of silence (8-bit mono), as a data: URL. */
export function silentWav(seconds = 0.25, rate = 8000) {
  const samples = Math.max(1, Math.round(seconds * rate));
  const word = (n) => String.fromCharCode(n & 0xff, (n >> 8) & 0xff);
  const dword = (n) => word(n) + word(n >>> 16);
  const header = "RIFF" + dword(36 + samples) + "WAVE"
    + "fmt " + dword(16) + word(1) + word(1) + dword(rate) + dword(rate) + word(1) + word(8)
    + "data" + dword(samples);
  return `data:audio/wav;base64,${btoa(header + String.fromCharCode(128).repeat(samples))}`;
}

/**
 * "allowed": sound may start by itself. "blocked": the browser refused it
 * (NotAllowedError). "unknown": the browser gave no answer (an old play()
 * that returns nothing, or no answer within PROBE_TIMEOUT_MS) or failed for
 * another reason.
 */
export async function probeAutoplay({ make = () => new Audio(), timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let audio;
  try {
    audio = make();
    audio.muted = false;
    audio.src = silentWav();
  } catch {
    return "unknown";
  }
  let attempt;
  try {
    attempt = audio.play();
  } catch (err) {
    return err && err.name === "NotAllowedError" ? "blocked" : "unknown";
  }
  if (!attempt || typeof attempt.then !== "function") return "unknown";
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("unknown"), timeoutMs); });
  const answer = attempt.then(
    () => "allowed",
    (err) => (err && err.name === "NotAllowedError" ? "blocked" : "unknown"),
  );
  const result = await Promise.race([answer, timeout]);
  clearTimeout(timer);
  try { audio.pause(); } catch { /* nothing to stop */ }
  return result;
}
