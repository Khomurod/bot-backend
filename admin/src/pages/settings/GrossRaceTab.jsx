import React from "react";
import CelebrationVideoCard from "./grossRace/CelebrationVideoCard";
import WindowsSoundCard from "./grossRace/WindowsSoundCard";

/**
 * Settings → Gross Grand Prix: the office race screens at /dispatch and
 * /dispatchteam. The video after the 4 PM celebration (see, pause, replace,
 * delete), and how to set up a Windows computer so it always plays with sound.
 * docs/architecture/gross-race.md.
 */
export default function GrossRaceTab() {
  return (
    <div>
      <CelebrationVideoCard />
      <WindowsSoundCard />
    </div>
  );
}
