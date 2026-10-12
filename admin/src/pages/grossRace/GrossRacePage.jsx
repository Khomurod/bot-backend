import React, { useCallback, useEffect, useRef, useState } from "react";
import { getGrossRace } from "../../api/grossRace";
import useVisibleInterval from "../../utils/useVisibleInterval";
import useFullscreen from "./useFullscreen";
import { EVENT_LIMIT, FLASH_MS, raceEvents } from "./raceEvents";
import { bannerView, ranked } from "./raceView";
import RaceHeader from "./RaceHeader";
import RaceTrack from "./RaceTrack";
import RaceSidebar from "./RaceSidebar";
import "./grossRace.css";

/**
 * The Gross Grand Prix: this week's gross race for the office screens.
 * /dispatchteam shows the dispatch teams, /dispatch the dispatchers.
 * Ported from the race design the owner approved (October 2026).
 *
 * The server reads Datatruck and holds the week (services/grossRace/feed.js);
 * this page polls it once a minute while the tab is visible, every few seconds
 * while the server is still reading the week. The race feed and the banner
 * come from comparing one reading with the last, here, as in the design.
 */

const POLL_MS = 60_000;
const WARMING_POLL_MS = 5_000;
const OFFLINE = "No connection to the server";

export default function GrossRacePage({ view }) {
  const [data, setData] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [events, setEvents] = useState([]);
  const [flashUntil, setFlashUntil] = useState({});
  const [banner, setBanner] = useState({ current: null, shown: null });
  const last = useRef(null);
  const fullscreen = useFullscreen();

  const load = useCallback(async () => {
    let next;
    try {
      next = await getGrossRace(view);
    } catch {
      setData((held) => (held && held.race
        ? { ...held, status: "stale", error: OFFLINE }
        : { ...(held || {}), status: "error", error: OFFLINE, race: null }));
      return;
    }
    setData(next);
    const weekStart = next.week ? next.week.start : null;
    if (last.current && last.current.weekStart !== weekStart) {
      // A new week is a new race: last week's feed, flashes and banner end with it.
      last.current = null;
      setEvents([]);
      setFlashUntil({});
      setBanner({ current: null, shown: null });
    }
    if (!next.race) return;
    const order = ranked(next.race);
    const previous = last.current ? last.current.order : null;
    last.current = { weekStart, order };
    const at = Date.now();
    const change = raceEvents(previous, order, at);
    if (change.events.length) setEvents((held) => [...change.events, ...held].slice(0, EVENT_LIMIT));
    if (change.flashed.length) {
      setFlashUntil((held) => ({ ...held, ...Object.fromEntries(change.flashed.map((id) => [id, at + FLASH_MS])) }));
    }
    if (change.banner) setBanner({ current: change.banner, shown: bannerView(change.banner) });
  }, [view]);

  useEffect(() => {
    document.title = `Gross Grand Prix · ${view === "teams" ? "Teams" : "Dispatchers"}`;
    load();
  }, [view, load]);

  useVisibleInterval(load, data && data.status === "loading" ? WARMING_POLL_MS : POLL_MS);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  return (
    <div className="gross-race">
      <RaceHeader view={view} data={data} now={now} fullscreen={fullscreen} />
      <div className="gr-body">
        <RaceTrack view={view} data={data} now={now} flashUntil={flashUntil} banner={banner} />
        <RaceSidebar data={data} now={now} events={events} />
      </div>
    </div>
  );
}

