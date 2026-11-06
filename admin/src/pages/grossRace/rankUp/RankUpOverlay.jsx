import React from "react";
import { ordinal } from "./pickRankUp";
import "./rankUp.css";

const AUTOPLAY_WORD = {
  checking: "checking…",
  allowed: "allowed — the chime plays by itself",
  blocked: "blocked — start Chrome with the shortcut in Settings → Gross Grand Prix",
  unknown: "could not tell",
};

/**
 * The big card when a racer climbs (the owner, 6 November 2026): in the middle
 * of the screen for a few seconds, the name very large, the places it moved
 * and whom it passed. A new leader gets the accent colour and "takes 1st place".
 * The Test sound button shows the same card, with what the screen can play.
 */
export default function RankUpOverlay({ card }) {
  if (!card) return null;
  const { name, rank, from, passed, leader, test, autoplay, chimed } = card;
  return (
    <div className={`gr-rankup${leader ? " gr-rankup-leader" : ""}`} role="status" aria-live="polite">
      <div className="gr-rankup-card">
        <div className="gr-rankup-kicker">{leader ? "New leader" : "Moving up"}</div>
        <div className="gr-rankup-name">{name}</div>
        <div className="gr-rankup-move">
          {leader ? "takes 1st place" : `↑ ${ordinal(from)} → ${ordinal(rank)}`}
        </div>
        {passed ? <div className="gr-rankup-passed">passed {passed}</div> : null}
        {test ? (
          <div className="gr-rankup-test">
            Sound test · chime {chimed === false ? "did not play" : chimed ? "played" : "…"} · sound by itself: {AUTOPLAY_WORD[autoplay] || AUTOPLAY_WORD.unknown}
          </div>
        ) : null}
      </div>
    </div>
  );
}
