import React from "react";
import { CheckIcon, CrossIcon } from "./RaceIcons";
import { weekRange } from "./raceFormat";

/**
 * The race's rule, on screen, so nobody has to ask why a load is or is not on
 * the board (the owner, 12 October 2026). The rule itself is the server's:
 * services/grossRace/standings.js, raceLoad() and countsInWeek().
 */
export default function RaceRules({ view, data }) {
  const week = data && data.week;
  const range = week ? weekRange(week) : "this week, Monday to Sunday";
  const creditedTo = view === "teams" ? "the load's dispatch team" : "whoever created the load";
  return (
    <div className="gr-rules">
      <span className="gr-rules-kicker">How it counts</span>
      <span className="gr-rule gr-rule--yes">
        <CheckIcon strokeWidth={3} />
        Counted: dispatched loads created, picked up and delivered {range} (Chicago time), credited to {creditedTo}
      </span>
      <span className="gr-rule gr-rule--no">
        <CrossIcon strokeWidth={3} />
        Not counted: booked or canceled loads, and any load created or picked up before Monday
      </span>
    </div>
  );
}
