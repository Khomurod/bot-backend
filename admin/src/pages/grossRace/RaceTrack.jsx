import React from "react";
import { EventIcon, FlagIcon, GaugeIcon } from "./RaceIcons";
import { emptyText, laneFontSize, lanesView } from "./raceView";
import { moneyK } from "./raceFormat";

/**
 * The track: one lane per racer on screen, the token moving toward the
 * checkered flag (teams) or out ahead by gross (dispatchers), and the banner
 * that slides up for a new leader, an overtake or a finish. With a `limit`
 * only the leaders race here (the dispatchers' board; RaceList holds the
 * rest), and a racer who climbs into the lanes flips in.
 */
export default function RaceTrack({ view, data, now, flashUntil, banner, limit = Infinity }) {
  const race = data && data.race;
  const lanes = lanesView(race, { now, flashUntil, limit });
  const empty = emptyText(data);
  const teams = view === "teams";
  const targets = (data && data.targets) || { solo: 15000, team: 20000 };
  const note = teams
    ? `Finish = 100% of target (${moneyK(targets.solo)} solo, ${moneyK(targets.team)} team truck)`
    : "Ranked by gross";
  const showBanner = Boolean(banner.current && banner.current.until > now);

  return (
    <section className="gr-track">
      <div className="gr-columns gr-track-head gr-kicker">
        <div>{teams ? "Team · trucks" : Number.isFinite(limit) ? `Top ${limit}` : "Dispatcher"}</div>
        <div className="gr-finish-note">{note}</div>
        <div>{teams ? "Gross / target" : "Loads"}</div>
      </div>

      <div className="gr-lanes">
        {lanes.map((lane, i) => (
          <div key={lane.id} className="gr-columns gr-lane gr-flip"
            style={{
              top: lane.top, height: lane.height, background: lane.rowBg,
              fontSize: laneFontSize(race, limit), animationDelay: `${i * 70}ms`,
            }}>
            <div className="gr-racer">
              <span className="gr-racer-name">{lane.name}</span>
              <div className="gr-lights">
                {lane.lights.map((light, i) => (
                  <span key={i} className="gr-light" style={{ width: light.width, background: light.bg }} />
                ))}
                {lane.finished && <span className="gr-tag gr-tag--accent"><FlagIcon strokeWidth={2.4} />Finished</span>}
                {lane.topRpm && <span className="gr-tag gr-tag--neutral"><GaugeIcon strokeWidth={2.4} />Top RPM</span>}
              </div>
            </div>
            <div className="gr-road">
              <div className="gr-road-line" />
              {lane.finishLeft && <div className="gr-flag" style={{ left: lane.finishLeft }} />}
              <div className="gr-trail" style={{ width: lane.trailWidth, background: lane.trailBg }} />
              <div className="gr-token" style={{ left: lane.tokenLeft, background: lane.tokenBg }}>
                <span>{lane.rank}</span>
              </div>
              <div className="gr-token-label" style={{ left: lane.labelLeft, color: lane.labelColor }}>{lane.label}</div>
            </div>
            <div className="gr-result">
              <span className="gr-result-main">{lane.result}</span>
              <span className="gr-result-sub" style={{ color: lane.detailColor }}>{lane.detail}</span>
            </div>
          </div>
        ))}
        {empty && <div className="gr-empty">{empty}</div>}
      </div>

      <div className="gr-banner" aria-live="polite" style={{ transform: `translateY(${showBanner ? "0%" : "110%"})` }}>
        <div className="gr-banner-icon">{banner.shown && <EventIcon type={banner.shown.type} />}</div>
        <div className="gr-banner-text">
          <span className="gr-banner-kicker">{banner.shown ? banner.shown.kicker : ""}</span>
          <span className="gr-banner-headline">{banner.shown ? banner.shown.text : ""}</span>
        </div>
      </div>
    </section>
  );
}
