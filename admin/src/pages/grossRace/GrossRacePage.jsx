import React, { useCallback, useEffect, useRef, useState } from "react";
import { getGrossRace } from "../../api/grossRace";
import useVisibleInterval from "../../utils/useVisibleInterval";
import useFullscreen from "./useFullscreen";
import { EVENT_LIMIT, FLASH_MS, raceEvents } from "./raceEvents";
import { bannerView, pageCount, ranked } from "./raceView";
import RaceHeader from "./RaceHeader";
import RaceRules from "./RaceRules";
import RaceTrack from "./RaceTrack";
import RaceSidebar from "./RaceSidebar";
import CelebrationOverlay from "./celebration/CelebrationOverlay";
import { CELEBRATION_MS, celebrationTick, celebrationWinner } from "./celebration/celebrationTime";
import { preloadCar } from "./celebration/carScene";
import { chunkOf, lastReloadAt, markReload, noteServed, shouldReload, tabStorage } from "./pageVersion";
import SoundTestOverlay from "./soundTest/SoundTestOverlay";
import useSoundTest from "./soundTest/useSoundTest";
import "./grossRace.css";

/**
 * The Gross Grand Prix: this week's gross race for the office screens.
 * /dispatchteam shows the dispatch teams, /dispatch the dispatchers.
 * Ported from the race design the owner approved (October 2026).
 *
 * The server reads Datatruck and holds the week (services/grossRace/feed.js);
 * this page polls it every 30 seconds while the tab is visible (so a load is on
 * screen within a minute of the server reading it), every few seconds while the
 * server is still reading the week. The race feed and the banner
 * come from comparing one reading with the last, here, as in the design.
 *
 * The dispatchers' board shows five racers at a time and turns to the next
 * five every ten seconds, round and round, like an airport departures board
 * (the owner, 12 October 2026). The teams fit on one screen.
 *
 * At 4:00 PM in Chicago, every day, the leader is celebrated for twelve seconds
 * over a 3D car (celebration/). `?celebrate` in the address shows it at once,
 * to preview it without waiting for four o'clock. The "Test sound" button runs
 * the celebration and then a clip with sound, and says what the screen can do
 * (soundTest/).
 *
 * Every answer also names the build of this page the server hands out; a
 * screen running an older one reloads itself (pageVersion.js), so a code
 * update reaches the office screens without anyone touching them.
 */

const POLL_MS = 30_000;
const DEFAULT_TZ = "America/Chicago";
const WARMING_POLL_MS = 5_000;
const OFFLINE = "No connection to the server";
export const PAGE_SIZE = { dispatchers: 5, teams: Infinity };
export const PAGE_MS = 10_000;
// The build this screen is running: the chunk Vite put this module in.
const OWN_CHUNK = chunkOf(import.meta.url);
const reloadPage = () => window.location.reload();

export default function GrossRacePage({ view, pageMs = PAGE_MS, ownChunk = OWN_CHUNK, reload = reloadPage }) {
  const [data, setData] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [events, setEvents] = useState([]);
  const [flashUntil, setFlashUntil] = useState({});
  const [banner, setBanner] = useState({ current: null, shown: null });
  const [page, setPage] = useState(0);
  const [celebration, setCelebrationState] = useState(null);
  // Mirrors `celebration` the moment it is set, for the reload check, which
  // runs in the same pass and would otherwise see the state before it changed.
  const celebrating = useRef(false);
  const setCelebration = useCallback((value) => {
    celebrating.current = Boolean(value);
    setCelebrationState(value);
  }, []);
  const celebratedOn = useRef(null);
  const preloading = useRef(false);
  const preview = useRef(typeof window !== "undefined" && new URLSearchParams(window.location.search).has("celebrate"));
  const reloading = useRef(false);
  const otherBuild = useRef(null); // a build the server named that is not ours, and how many times in a row
  const last = useRef(null);
  const fullscreen = useFullscreen();
  const sound = useSoundTest({ race: data && data.race, celebration, setCelebration });
  const pageSize = PAGE_SIZE[view] || Infinity;
  const pages = pageCount(data && data.race, pageSize);

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
    otherBuild.current = noteServed(otherBuild.current, next.page, ownChunk);
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
  }, [view, ownChunk]);

  useEffect(() => {
    document.title = `Gross Grand Prix · ${view === "teams" ? "Teams" : "Dispatchers"}`;
    load();
  }, [view, load]);

  useVisibleInterval(load, data && data.status === "loading" ? WARMING_POLL_MS : POLL_MS);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // 4:00 PM: celebrate the leader once a day; fetch the car in the minutes before.
  useEffect(() => {
    const tz = (data && data.week && data.week.tz) || DEFAULT_TZ;
    const tick = celebrationTick(now, tz, celebratedOn.current, data && data.race);
    if (tick.preload && !preloading.current) {
      preloading.current = true;
      preloadCar().catch(() => { preloading.current = false; });
    }
    if (!tick.winner) return;
    celebratedOn.current = tick.day;
    setCelebration({ winner: tick.winner, until: now + CELEBRATION_MS });
  }, [now, data, setCelebration]);

  useEffect(() => {
    if (!preview.current || !data || !data.race) return;
    preview.current = false;
    const winner = celebrationWinner(data.race);
    if (winner) setCelebration({ winner, until: Date.now() + CELEBRATION_MS });
  }, [data, setCelebration]);

  useEffect(() => {
    if (celebration && now >= celebration.until) setCelebration(null);
  }, [now, celebration, setCelebration]);

  // A newer build of this page is out: reload, unless now is a bad moment.
  useEffect(() => {
    if (reloading.current || !data || !data.page) return;
    const tz = (data.week && data.week.tz) || DEFAULT_TZ;
    const storage = tabStorage();
    const due = shouldReload({
      own: ownChunk, served: data.page, confirmations: otherBuild.current && otherBuild.current.name === data.page ? otherBuild.current.count : 0,
      now, tz, celebrating: celebrating.current || sound.active.current, lastReloadAt: lastReloadAt(storage),
    });
    if (!due) return;
    reloading.current = true;
    markReload(storage, now);
    reload();
  }, [data, now, ownChunk, reload, sound.active]);

  useEffect(() => {
    setPage((held) => (held < pages ? held : 0));
    if (pages <= 1) return undefined;
    const turn = setInterval(() => setPage((held) => (held + 1) % pages), pageMs);
    return () => clearInterval(turn);
  }, [pages, pageMs]);

  return (
    <div className="gross-race">
      <RaceHeader view={view} data={data} now={now} fullscreen={fullscreen} onSoundTest={sound.start} />
      <RaceRules view={view} data={data} />
      <div className="gr-body">
        <RaceTrack view={view} data={data} now={now} flashUntil={flashUntil} banner={banner}
          page={Math.min(page, pages - 1)} pages={pages} pageSize={pageSize} />
        <RaceSidebar data={data} now={now} events={events} />
      </div>
      {celebration && <CelebrationOverlay winner={celebration.winner} view={view} onCar={sound.noteCar} />}
      {sound.test && sound.test.stage === "video" && (
        <SoundTestOverlay autoplay={sound.autoplay} car={sound.test.car} onClose={sound.close} />
      )}
    </div>
  );
}

