import React from "react";
import { EventIcon } from "./RaceIcons";
import { feedView, podiumView } from "./raceView";

/** The podium (2 · 1 · 3) and the race feed. */
export default function RaceSidebar({ data, now, events }) {
  const podium = podiumView(data && data.race);
  const feed = feedView(events, now);

  return (
    <aside className="gr-aside">
      <div className="gr-podium-box">
        <div className="gr-kicker">Podium</div>
        <div className="gr-podium">
          {podium.map((step) => (
            <div key={step.rank} className="gr-podium-step">
              <span className="gr-podium-name">{step.name}</span>
              <span className="gr-podium-metric" style={{ color: step.metricColor }}>{step.metric}</span>
              <span className="gr-podium-gross">{step.gross}</span>
              <div className="gr-podium-block" style={{ height: step.height, background: step.bg }}>{step.rank}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="gr-feed">
        <div className="gr-kicker">Race feed</div>
        {feed.length === 0 && (
          <div className="gr-feed-empty">Waiting for the next move. Every delivered load pushes a racer forward.</div>
        )}
        {feed.map((line) => (
          <div key={line.key} className="gr-event" style={{ background: line.bg }}>
            <span className="gr-event-icon" style={{ color: line.iconColor }}>
              <EventIcon type={line.type} size="1.1em" strokeWidth={2.2} />
            </span>
            <div className="gr-event-body">
              <span className="gr-event-text">{line.text}</span>
              <span className="gr-event-ago">{line.ago}</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
