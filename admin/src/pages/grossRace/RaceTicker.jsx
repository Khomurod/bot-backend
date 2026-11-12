import React from "react";
import { EventIcon } from "./RaceIcons";
import { feedView } from "./raceView";

/**
 * The race feed as one line along the bottom of the dispatchers' board, the
 * newest first — the same lines the teams' board keeps in its sidebar.
 */
export default function RaceTicker({ now, events }) {
  const feed = feedView(events, now);

  return (
    <div className="gr-ticker">
      <span className="gr-kicker">Race feed</span>
      {feed.length === 0 && (
        <span className="gr-ticker-empty">Waiting for the next move. Every delivered load pushes a racer forward.</span>
      )}
      {feed.map((line) => (
        <span key={line.key} className="gr-ticker-item" style={{ background: line.bg }}>
          <span className="gr-event-icon" style={{ color: line.iconColor }}>
            <EventIcon type={line.type} size="1.1em" strokeWidth={2.2} />
          </span>
          <span className="gr-event-text">{line.text}</span>
          <span className="gr-event-ago">{line.ago}</span>
        </span>
      ))}
    </div>
  );
}
