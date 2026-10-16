import React, { useEffect, useRef, useState } from "react";
import clipUrl from "./sound-test.mp4?url";
import "./soundTest.css";

/**
 * The sound test's second half: after the celebration, a five-second clip of
 * our own (two chimes, no third-party content) plays with sound, then a card
 * says what this screen can do. The owner reads it off the TV; it decides how
 * the 4 PM video will have to start (the owner, 16 October 2026).
 *
 * The clip is started by the button press that began the test, so it shows
 * whether the TV can play video and sound at all. Whether sound may start
 * WITHOUT a press is the page-load probe's answer (autoplayProbe.js).
 */
export const CARD_MS = 60_000;
// A clip that never reports its end (a stalled TV decoder) still ends the test.
const CLIP_LIMIT_MS = 15_000;

const AUTOPLAY_TEXT = {
  allowed: ["yes", "Sound can start by itself: YES"],
  blocked: ["no", "Sound can start by itself: NO (needs a click first)"],
  unknown: ["maybe", "Sound can start by itself: UNKNOWN"],
  checking: ["maybe", "Sound can start by itself: still checking"],
};
const PLAYBACK_TEXT = {
  sound: ["yes", "Test video played WITH sound"],
  muted: ["no", "Test video played, but only WITHOUT sound"],
  failed: ["no", "Test video did NOT play"],
};
const CAR_TEXT = {
  on: ["yes", "3D car: shown"],
  off: ["maybe", "3D car: not supported here, a trophy was shown instead"],
};

function play(video) {
  try {
    return Promise.resolve(video.play());
  } catch (err) {
    return Promise.reject(err);
  }
}

function Row({ entry }) {
  const [tone, text] = entry;
  return <li className={`gr-soundtest-row is-${tone}`}>{text}</li>;
}

export default function SoundTestOverlay({ autoplay, car, onClose, userAgent }) {
  const video = useRef(null);
  const [playback, setPlayback] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const el = video.current;
    let gone = false;
    el.muted = false;
    play(el)
      .then(() => { if (!gone) setPlayback("sound"); })
      .catch((err) => {
        if (!err || err.name !== "NotAllowedError") throw err;
        el.muted = true;
        return play(el).then(() => { if (!gone) setPlayback("muted"); });
      })
      .catch(() => { if (!gone) { setPlayback("failed"); setDone(true); } });
    const limit = setTimeout(() => { if (!gone) setDone(true); }, CLIP_LIMIT_MS);
    return () => { gone = true; clearTimeout(limit); };
  }, []);

  useEffect(() => {
    if (!done) return undefined;
    const close = setTimeout(onClose, CARD_MS);
    return () => clearTimeout(close);
  }, [done, onClose]);

  const agent = String(userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")).slice(0, 160);

  return (
    <div className="gr-soundtest" role="dialog" aria-label="Sound test">
      <video ref={video} className="gr-soundtest-video" src={clipUrl} playsInline preload="auto"
        onEnded={() => setDone(true)} onError={() => { setPlayback("failed"); setDone(true); }} />
      {done && (
        <div className="gr-soundtest-card">
          <div className="gr-soundtest-title">Sound test: this screen</div>
          <ul className="gr-soundtest-rows">
            <Row entry={AUTOPLAY_TEXT[autoplay] || AUTOPLAY_TEXT.unknown} />
            <Row entry={PLAYBACK_TEXT[playback] || PLAYBACK_TEXT.failed} />
            {CAR_TEXT[car] && <Row entry={CAR_TEXT[car]} />}
          </ul>
          <div className="gr-soundtest-agent">{agent}</div>
          <button type="button" className="gr-btn gr-soundtest-close" onClick={onClose}>Close</button>
        </div>
      )}
    </div>
  );
}
