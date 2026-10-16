import React from "react";
import { MaximizeIcon, MinimizeIcon, SpeakerIcon } from "./RaceIcons";
import { OTHER_DISPLAY, statusView, weekView } from "./raceView";

/**
 * The header: title and display, the week's laps, the countdown to the
 * checkered flag, the live status, the other display, the sound test and the
 * full-screen button. In full screen the button turns into the one that leaves it.
 */
export default function RaceHeader({ view, data, now, fullscreen, onSoundTest }) {
  const week = weekView(data, now);
  const status = statusView(data, now);
  const other = OTHER_DISPLAY[view];
  const FullscreenIcon = fullscreen.active ? MinimizeIcon : MaximizeIcon;
  const fullscreenLabel = fullscreen.active ? "Exit full screen" : "Full screen";

  return (
    <header className="gr-header">
      <div className="gr-cell gr-cell--title">
        <div className="gr-title-block">
          <div className="gr-kicker gr-week">Datatruck · Week of {week.weekLabel}</div>
          <h1 className="gr-title">Gross Grand Prix</h1>
        </div>
        <div className="gr-view-badge">{view === "teams" ? "Teams" : "Dispatchers"}</div>
      </div>

      <div className="gr-cell">
        <div className="gr-kicker">{week.lapLabel}</div>
        <div className="gr-laps">
          {week.laps.map((bg, i) => <div key={i} style={{ background: bg }} />)}
        </div>
      </div>

      <div className="gr-cell">
        <div className="gr-kicker">Checkered flag in</div>
        <div className="gr-countdown">{week.countdown}</div>
      </div>

      <div className="gr-cell" style={{ gap: 8 }}>
        <div className="gr-status">
          <span className="gr-status-dot" style={{ background: status.dot, opacity: status.dotOpacity }} />
          <span className="gr-status-label">{status.label}</span>
          <span className="gr-status-line" style={{ color: status.color }}>{status.line}</span>
        </div>
        <div className="gr-actions">
          <a className="gr-btn" href={other.href}>{other.label}</a>
          {onSoundTest && (
            <button type="button" className="gr-btn" onClick={onSoundTest}>
              <SpeakerIcon size="14" strokeWidth={2.4} />
              Test sound
            </button>
          )}
          {fullscreen.supported && (
            <button type="button" className="gr-btn" onClick={fullscreen.toggle}
              aria-label={fullscreenLabel} title={fullscreenLabel} aria-pressed={fullscreen.active}>
              <FullscreenIcon size="14" strokeWidth={2.4} />
              {fullscreenLabel}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
