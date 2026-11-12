import React from "react";
import { GaugeIcon } from "./RaceIcons";
import { listFontSize, listView, SPOTLIGHT } from "./raceView";

/**
 * The dispatchers' board, right half: everybody after the leaders' lanes, one
 * row each — place, name, a bar of their gross against the leader's, gross,
 * loads (the owner, 12 November 2026: all on one screen instead of five to a
 * screen turning). A row slides to its new place when places change, and
 * lights up for a moment on a gain, as a lane does.
 */
export default function RaceList({ data, now, flashUntil }) {
  const race = data && data.race;
  const rows = listView(race, { now, flashUntil });
  const count = race ? race.racers.length : 0;
  const first = SPOTLIGHT + 1;
  const heading = count > first ? `Places ${first}–${count}` : count === first ? `Place ${first}` : `Places ${first} and on`;

  return (
    <section className="gr-list" aria-label={`Places ${first} and on`}>
      <div className="gr-list-row gr-list-head gr-kicker">
        <div>{heading}</div>
        <div className="gr-list-num">Gross</div>
        <div className="gr-list-num">Loads</div>
      </div>
      <div className="gr-list-rows" style={{ fontSize: listFontSize(rows.length) }}>
        {rows.map((row) => (
          <div key={row.id} className="gr-list-row gr-list-item" style={{ top: row.top, height: row.height, background: row.rowBg }}>
            <span className="gr-list-rank">{row.rank}</span>
            <span className="gr-list-name">
              {row.name}
              {row.topRpm && <span className="gr-tag gr-tag--neutral"><GaugeIcon strokeWidth={2.4} />Top RPM</span>}
            </span>
            <span className="gr-list-bar"><span style={{ width: row.bar }} /></span>
            <span className="gr-list-num gr-list-gross">{row.gross}</span>
            <span className="gr-list-num gr-list-loads">{row.loads}</span>
          </div>
        ))}
        {race && rows.length === 0 && (
          <div className="gr-list-empty">Everyone after the top {SPOTLIGHT} lines up here.</div>
        )}
      </div>
    </section>
  );
}
