import React, { useEffect, useRef } from "react";
import { GROSS_RACE_VIDEO_URL } from "../../../api/grossRace";

/** However long the video is, the board is back after this. */
export const VIDEO_MAX_MS = 3 * 60_000;

/**
 * The video after the 4 PM celebration, over the whole board. It is fetched
 * while the car is still on screen (`playing` false: mounted, out of sight)
 * and starts when `playing` turns true: with sound if the TV allows it,
 * otherwise without, rather than not at all. When it ends, fails, or runs past
 * VIDEO_MAX_MS, `onDone`.
 */
export default function CelebrationVideo({ playing, onDone, src = GROSS_RACE_VIDEO_URL, maxMs = VIDEO_MAX_MS }) {
  const video = useRef(null);
  const finished = useRef(false);
  const finish = useRef(onDone);
  finish.current = () => {
    if (finished.current) return;
    finished.current = true;
    onDone();
  };

  useEffect(() => {
    if (!playing) return undefined;
    const element = video.current;
    let gone = false;
    const start = (muted) => {
      element.muted = muted;
      return Promise.resolve(element.play());
    };
    start(false).catch((err) => {
      if (gone) return undefined;
      if (err && err.name === "NotAllowedError") return start(true).catch(() => { if (!gone) finish.current(); });
      finish.current();
      return undefined;
    });
    const limit = setTimeout(() => finish.current(), maxMs);
    return () => {
      gone = true;
      clearTimeout(limit);
      try { element.pause(); } catch { /* nothing to stop */ }
    };
  }, [playing, maxMs]);

  return (
    <div className={`gr-celvideo${playing ? " is-playing" : ""}`} role={playing ? "dialog" : undefined}
      aria-label={playing ? "Celebration video" : undefined} aria-hidden={playing ? undefined : "true"}>
      <video ref={video} className="gr-celvideo-video" src={src} preload="auto" playsInline
        onEnded={() => finish.current()} onError={() => finish.current()} />
    </div>
  );
}
