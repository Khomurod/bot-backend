/**
 * Full-screen 10-minute SOS presentation timer (projector feature).
 *
 * Presentation only: it reads nothing and writes nothing. No SOS answer, score,
 * summary or setting is touched — opening, pausing or closing it cannot affect
 * the data on the page behind it.
 *
 * Fullscreen: the overlay asks for real fullscreen through the Fullscreen API.
 * If the API is absent or the request is DENIED (rejected promise), it stays a
 * fixed full-window overlay instead — same visuals, no crash, no dead end.
 * Leaving browser fullscreen (Escape, F11, the OS) is caught by
 * `fullscreenchange` and simply drops back to the full-window presentation with
 * the countdown still running; Escape as a key press closes the timer, and
 * closing always releases fullscreen and the interval.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import "./sosTimer.css";
import useSosTimer from "./useSosTimer";
import playCompletionChime from "./sosTimerChime";
import { formatClock } from "./sosTimerModel";

export default function SosPresentationTimer({
  isTest = false,
  onClose,
  seed,
  totalMs,
  tickMs,
  chime = playCompletionChime,
}) {
  const rootRef = useRef(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const chimeRef = useRef(chime);
  chimeRef.current = chime;

  // Runs inside an effect at 00:00, so it must never throw: the completion
  // sound is optional, the completion state is not.
  const handleFinish = useCallback(() => {
    try {
      if (chimeRef.current) chimeRef.current();
    } catch (_) { /* presentation audio is best-effort */ }
  }, []);

  const timer = useSosTimer({ totalMs, seed, tickMs, onFinish: handleFinish });
  const { status, finished, phase, message, remainingMs, remainingFraction } = timer;

  const isFullscreenElement = () => typeof document !== "undefined"
    && rootRef.current != null
    && document.fullscreenElement === rootRef.current;

  const releaseFullscreen = useCallback(() => {
    if (typeof document === "undefined" || !document.fullscreenElement) return;
    if (typeof document.exitFullscreen !== "function") return;
    try {
      const exited = document.exitFullscreen();
      if (exited && typeof exited.catch === "function") exited.catch(() => {});
    } catch (_) { /* already out of fullscreen */ }
  }, []);

  const close = useCallback(() => {
    releaseFullscreen();
    if (onClose) onClose();
  }, [onClose, releaseFullscreen]);

  // Request fullscreen once, on open — a rejection is an expected outcome.
  useEffect(() => {
    let cancelled = false;
    const element = rootRef.current;
    if (!element || typeof element.requestFullscreen !== "function") return undefined;
    try {
      const request = element.requestFullscreen();
      if (request && typeof request.then === "function") {
        request.then(
          () => { if (!cancelled) setNativeFullscreen(true); },
          () => { if (!cancelled) setNativeFullscreen(false); }, // denied → window fallback
        );
      } else {
        setNativeFullscreen(true);
      }
    } catch (_) {
      setNativeFullscreen(false);
    }
    return () => { cancelled = true; };
  }, []);

  // Track leaving fullscreen by any route, and always release it on unmount.
  useEffect(() => {
    const onFullscreenChange = () => setNativeFullscreen(isFullscreenElement());
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      releaseFullscreen();
    };
  }, [releaseFullscreen]);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const showClock = finished || phase === "countdown";
  const showMessage = !finished && phase === "message";

  return (
    <div
      ref={rootRef}
      className={`sos-timer${nativeFullscreen ? " is-native" : " is-window"}`}
      role="dialog"
      aria-modal="true"
      aria-label="10 daqiqalik SOS taymeri"
      data-testid="sos-timer"
      data-fullscreen={nativeFullscreen ? "native" : "window"}
      data-phase={finished ? "finished" : phase}
      data-status={status}
    >
      {isTest && (
        <div className="sos-timer-test" data-testid="sos-timer-test-badge">🧪 TEST rejimi</div>
      )}

      <div className="sos-timer-stage">
        <div className={`sos-timer-layer${showClock ? " is-visible" : ""}`} aria-hidden={!showClock}>
          <div className="sos-timer-digits" data-testid="sos-timer-clock">{formatClock(remainingMs)}</div>
          <div className="sos-timer-caption">
            {finished ? "Savol Ortidagi Savol — SOS" : "Savol Ortidagi Savol — SOS taqdimoti"}
          </div>
        </div>
        <div className={`sos-timer-layer${showMessage ? " is-visible" : ""}`} aria-hidden={!showMessage}>
          <p className="sos-timer-message" data-testid="sos-timer-message">{message}</p>
        </div>
      </div>

      {finished && (
        <div className="sos-timer-done" role="status" data-testid="sos-timer-done">
          Vaqt tugadi — eʼtiboringiz uchun rahmat
        </div>
      )}
      {status === "paused" && (
        <div className="sos-timer-paused" role="status" data-testid="sos-timer-paused">
          ⏸ Vaqtinchalik toʻxtatildi
        </div>
      )}

      <div
        className="sos-timer-progress"
        role="progressbar"
        aria-label="Qolgan vaqt"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remainingFraction * 100)}
      >
        <div
          className="sos-timer-progress-fill"
          data-testid="sos-timer-progress"
          style={{ width: `${remainingFraction * 100}%` }}
        />
      </div>

      <div className="sos-timer-controls">
        {status === "running" && (
          <button type="button" className="sos-timer-btn" onClick={timer.pause}>⏸ Pauza</button>
        )}
        {status === "paused" && (
          <button type="button" className="sos-timer-btn" onClick={timer.resume}>▶ Davom etish</button>
        )}
        <button type="button" className="sos-timer-btn" onClick={timer.restart}>⟲ Qaytadan (10:00)</button>
        <button type="button" className="sos-timer-btn sos-timer-btn--exit" onClick={close}>✕ Chiqish</button>
      </div>
    </div>
  );
}
