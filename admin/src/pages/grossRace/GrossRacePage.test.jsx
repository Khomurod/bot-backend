/**
 * The Gross Grand Prix display: it shows the race the server holds, says when
 * it cannot, and its full-screen button turns into the one that leaves full
 * screen while the page is in it, whichever way full screen was entered or left.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GrossRacePage from "./GrossRacePage";

vi.mock("./celebration/carScene", () => ({
  supportsWebGL: () => false, mountCarScene: vi.fn(), preloadCar: () => Promise.resolve(),
}));

const week = { start: "2026-10-12T05:00:00.000Z", end: "2026-10-19T05:00:00.000Z", label: "Oct 12–19", day: 3, dayName: "Wed", tz: "America/Chicago" };
const racer = (name, rank, gross, target) => ({
  id: name, name, rank, gross, target, pct: gross / target, loads: 3, miles: 2000, rpm: gross / 2000,
  gap: 0, gapPct: 0, lights: [{ team: false, hit: false }], hitNames: [],
});
const live = {
  view: "teams", status: "live", error: null, updatedAt: "2026-10-14T18:00:00.000Z", week,
  targets: { solo: 15000, team: 20000 },
  race: {
    racers: [racer("Bison's Team", 2, 30000, 60000), racer("Falcon's Team", 1, 45000, 60000)],
    lead: 45000, leadPct: 0.75, maxTarget: 60000, topRpmId: null, rankBy: "percent",
  },
};

let fetchMock;
function respond(body) {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
}

let entered;
let exited;
beforeEach(() => {
  entered = vi.fn(async () => {
    document.fullscreenElement = document.documentElement;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  exited = vi.fn(async () => {
    document.fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  document.documentElement.requestFullscreen = entered;
  document.exitFullscreen = exited;
  document.fullscreenElement = null;
});

afterEach(() => {
  delete document.documentElement.requestFullscreen;
  delete document.exitFullscreen;
  delete document.fullscreenElement;
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GrossRacePage", () => {
  test("shows the race the server holds, and links the other display", async () => {
    respond(live);
    render(<GrossRacePage view="teams" />);

    expect(await screen.findAllByText("Falcon's Team")).not.toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith("/api/gross-race?view=teams", { cache: "no-store" });
    expect(screen.getByText("Datatruck · Week of Oct 12–19")).toBeInTheDocument();
    expect(screen.getByText("Lap 3 of 7 · Wed")).toBeInTheDocument();
    expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Dispatchers race" })).toHaveAttribute("href", "/dispatch");
    expect(screen.getByText(/Counted: dispatched loads created, picked up and delivered Mon, Oct 12 – Sun, Oct 18 \(Chicago time\), credited to the load's dispatch team/)).toBeInTheDocument();
    expect(screen.getByText(/Not counted: booked or canceled loads, and any load created or picked up before Monday/)).toBeInTheDocument();
    expect(document.title).toBe("Gross Grand Prix · Teams");
  });

  test("the full-screen button becomes the exit button in full screen, and back", async () => {
    respond(live);
    const user = userEvent.setup();
    render(<GrossRacePage view="dispatchers" />);

    await user.click(await screen.findByRole("button", { name: "Full screen" }));
    expect(entered).toHaveBeenCalledTimes(1);
    const exit = await screen.findByRole("button", { name: "Exit full screen" });
    expect(exit).toHaveAttribute("aria-pressed", "true");

    await user.click(exit);
    expect(exited).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Full screen" })).toBeInTheDocument();
  });

  test("leaving full screen with Esc turns the button back too", async () => {
    respond(live);
    const user = userEvent.setup();
    render(<GrossRacePage view="teams" />);
    await user.click(await screen.findByRole("button", { name: "Full screen" }));
    await screen.findByRole("button", { name: "Exit full screen" });

    act(() => {
      document.fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(await screen.findByRole("button", { name: "Full screen" })).toBeInTheDocument();
  });

  test("a new week clears last week's feed and banner", async () => {
    respond(live);
    render(<GrossRacePage view="teams" />);
    await screen.findAllByText("Falcon's Team");

    // Bison overtakes Falcon: a feed line and the banner.
    respond({
      ...live,
      race: { ...live.race, racers: [racer("Bison's Team", 1, 50000, 60000), racer("Falcon's Team", 2, 45000, 60000)] },
    });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(await screen.findByText("Bison's Team takes the lead!")).toBeInTheDocument();
    expect(screen.getByText("Bison's Team takes 1st place!")).toBeInTheDocument();

    // Monday: the server is on the next week.
    const nextWeek = { ...week, start: "2026-10-19T05:00:00.000Z", end: "2026-10-26T05:00:00.000Z", label: "Oct 19–26", day: 1, dayName: "Mon" };
    respond({ ...live, week: nextWeek, race: { ...live.race, racers: [], lead: 0, leadPct: 0, maxTarget: 0 } });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(await screen.findByText("Datatruck · Week of Oct 19–26")).toBeInTheDocument();
    expect(screen.queryByText("Bison's Team takes the lead!")).not.toBeInTheDocument();
    expect(screen.queryByText("Bison's Team takes 1st place!")).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting for the next move/)).toBeInTheDocument();
  });

  test("the dispatchers' board: gross only, five to a screen, turning like an airport board", async () => {
    const names = ["Ann", "Bo", "Cy", "Di", "Ed", "Flo", "Gus"].map((n) => `${n} Example`);
    const racers = names.map((name, i) => ({
      id: name, name, rank: i + 1, gross: 70000 - i * 10000, loads: 7 - i, miles: 20000, rpm: 3, gap: i * 10000,
    }));
    respond({
      ...live, view: "dispatchers", targets: null,
      race: { racers, lead: 70000, topRpmId: null, rankBy: "gross" },
    });
    render(<GrossRacePage view="dispatchers" pageMs={60} />);

    expect(await screen.findByText("Board 1 of 2")).toBeInTheDocument();
    for (const name of names.slice(0, 5)) expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    expect(screen.queryByText("Flo Example")).not.toBeInTheDocument();
    expect(screen.getByText("Ranked by gross")).toBeInTheDocument();
    expect(screen.getByText(/credited to whoever created the load/)).toBeInTheDocument();
    expect(screen.getAllByText("$70,000").length).toBeGreaterThan(0);
    expect(screen.queryByText(/%|target/i)).not.toBeInTheDocument();

    expect(await screen.findByText("Board 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("Flo Example")).toBeInTheDocument();
    expect(screen.getByText("Gus Example")).toBeInTheDocument();
    expect(await screen.findByText("Board 1 of 2")).toBeInTheDocument();
  });

  test("?celebrate previews the 4 PM celebration of the race leader", async () => {
    window.history.pushState({}, "", "/dispatchteam?celebrate");
    try {
      respond(live);
      render(<GrossRacePage view="teams" />);
      const dialog = await screen.findByRole("dialog", { name: "Today's leader" });
      expect(dialog).toHaveTextContent("Falcon's Team");
      expect(dialog).toHaveTextContent("You took first place! Keep it up, and one day you'll buy a great new car.");
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  test("a screen running an older build of the page reloads itself, once", async () => {
    respond({ ...live, page: "GrossRacePage-new2.js" });
    const reload = vi.fn();
    render(<GrossRacePage view="teams" ownChunk="GrossRacePage-old1.js" reload={reload} />);
    await screen.findAllByText("Falcon's Team");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(Number(window.sessionStorage.getItem("grossRace.reloadedAt"))).toBeGreaterThan(0);

    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("the same build, or a server that names none, never reloads", async () => {
    for (const page of ["GrossRacePage-same.js", null]) {
      respond({ ...live, page });
      const reload = vi.fn();
      const { unmount } = render(<GrossRacePage view="teams" ownChunk="GrossRacePage-same.js" reload={reload} />);
      await screen.findAllByText("Falcon's Team");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reload).not.toHaveBeenCalled();
      unmount();
    }
  });

  test("not while the celebration is on screen", async () => {
    window.history.pushState({}, "", "/dispatchteam?celebrate");
    try {
      respond({ ...live, page: "GrossRacePage-new2.js" });
      const reload = vi.fn();
      render(<GrossRacePage view="teams" ownChunk="GrossRacePage-old1.js" reload={reload} />);
      await screen.findByRole("dialog", { name: "Today's leader" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reload).not.toHaveBeenCalled();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  test("says plainly when Datatruck is not reachable", async () => {
    respond({ ...live, status: "error", error: "Datatruck is not connected", race: null });
    render(<GrossRacePage view="teams" />);
    await waitFor(() => expect(screen.getByText("Offline")).toBeInTheDocument());
    expect(screen.getAllByText("Datatruck is not connected").length).toBeGreaterThan(0);
  });
});
