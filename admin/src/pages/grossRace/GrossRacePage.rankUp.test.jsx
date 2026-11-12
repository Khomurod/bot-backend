/**
 * The climb card on the boards (rankUp/; the owner, 6 November 2026): it shows
 * on an overtake in place of the bottom banner, never over the celebration, on
 * /dispatch the climber's row is already in its new place, it holds back a
 * reload, and /dispatch's Test sound shows it with the chime.
 */
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GrossRacePage from "./GrossRacePage";

vi.mock("./celebration/carScene", () => ({
  supportsWebGL: () => false, mountCarScene: vi.fn(), preloadCar: () => Promise.resolve(),
}));
vi.mock("./soundTest/autoplayProbe", () => ({ probeAutoplay: async () => "blocked" }));
vi.mock("./celebration/catchUp", async (actual) => ({ ...(await actual()), catchUpDay: () => null }));

const week = { start: "2026-10-12T05:00:00.000Z", end: "2026-10-19T05:00:00.000Z", label: "Oct 12–19", day: 3, dayName: "Wed", tz: "America/Chicago" };
const team = (name, rank, gross) => ({
  id: name, name, rank, gross, target: 60000, pct: gross / 60000, loads: 3, miles: 2000, rpm: gross / 2000,
  gap: 0, gapPct: 0, lights: [{ team: false, hit: false }], hitNames: [],
});
const teams = (racers) => ({
  view: "teams", status: "live", error: null, updatedAt: "2026-10-14T18:00:00.000Z", week, targets: { solo: 15000, team: 20000 },
  race: { racers, lead: racers[0].gross, leadPct: 0.75, maxTarget: 60000, topRpmId: null, rankBy: "percent" },
});
const dispatchers = (order) => ({
  view: "dispatchers", status: "live", error: null, updatedAt: "2026-10-14T18:00:00.000Z", week, targets: null,
  race: {
    racers: order.map((name, i) => ({ id: name, name, rank: i + 1, gross: 70000 - i * 10000, loads: 7 - i, miles: 20000, rpm: 3, gap: i * 10000 })),
    lead: 70000, topRpmId: null, rankBy: "gross",
  },
});
const NAMES = ["Ann", "Bo", "Cy", "Di", "Ed", "Flo", "Gus"].map((n) => `${n} Example`);

function respond(body) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
}
const poll = async (ms = 50) => {
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await new Promise((resolve) => setTimeout(resolve, ms));
};
const card = () => screen.queryByRole("status");
const bannerHeadline = () => document.querySelector(".gr-banner-headline").textContent;

afterEach(() => {
  window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the climb card", () => {
  test("an overtake: the big card, in place of the bottom banner; the feed keeps the line", async () => {
    respond(teams([team("Ann's Team", 1, 50000), team("Bo's Team", 2, 40000), team("Cy's Team", 3, 30000)]));
    render(<GrossRacePage view="teams" />);
    await screen.findAllByText("Cy's Team");
    respond(teams([team("Ann's Team", 1, 50000), team("Cy's Team", 2, 45000), team("Bo's Team", 3, 40000)]));
    await poll();

    expect(card()).toHaveTextContent("Moving up");
    expect(card()).toHaveTextContent("Cy's Team");
    expect(card()).toHaveTextContent("↑ 3rd → 2nd");
    expect(card()).toHaveTextContent("passed Bo's Team");
    expect(bannerHeadline()).toBe("");
    expect(screen.getByText("Cy's Team passes Bo's Team for 2nd")).toBeInTheDocument();
  });

  test("a second climb inside the minute gets the banner, not another card", async () => {
    respond(teams([team("Ann's Team", 1, 50000), team("Bo's Team", 2, 40000), team("Cy's Team", 3, 30000)]));
    render(<GrossRacePage view="teams" />);
    await screen.findAllByText("Cy's Team");
    respond(teams([team("Ann's Team", 1, 50000), team("Cy's Team", 2, 45000), team("Bo's Team", 3, 40000)]));
    await poll();
    expect(card()).toHaveTextContent("Cy's Team");
    respond(teams([team("Cy's Team", 1, 55000), team("Ann's Team", 2, 50000), team("Bo's Team", 3, 40000)]));
    await poll();
    expect(card()).toHaveTextContent("Cy's Team"); // the first card, still its seven seconds
    expect(card()).not.toHaveTextContent("takes 1st place");
  });

  test("never over the 4 PM celebration", async () => {
    window.history.pushState({}, "", "/dispatchteam?celebrate");
    respond(teams([team("Ann's Team", 1, 50000), team("Bo's Team", 2, 40000)]));
    render(<GrossRacePage view="teams" />);
    await screen.findByRole("dialog", { name: "Today's leader" });
    respond(teams([team("Bo's Team", 1, 55000), team("Ann's Team", 2, 50000)]));
    await poll();
    expect(screen.getByText("Bo's Team takes the lead!")).toBeInTheDocument();
    expect(card()).toBe(null);
  });

  test("/dispatch: a climb in the list gets the card, and the climber's row has moved up", async () => {
    respond(dispatchers(NAMES));
    render(<GrossRacePage view="dispatchers" />);
    await screen.findByRole("region", { name: "Places 6 and on" });
    const climbed = [...NAMES.slice(0, 5), NAMES[6], NAMES[5]]; // Gus 7th → 6th, past Flo
    respond(dispatchers(climbed));
    await poll();
    expect(card()).toHaveTextContent("Gus Example");
    expect(card()).toHaveTextContent("↑ 7th → 6th");
    const row = (name) => within(screen.getByRole("region", { name: "Places 6 and on" })).getByText(name).closest(".gr-list-item");
    expect(row("Gus Example").style.top).toBe("0%");
    expect(row("Flo Example").style.top).toBe("50%");
  });

  test("a newer build waits while the card is on screen", async () => {
    // 10 AM in Chicago: away from the 4 PM minute, when a reload waits anyway.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: new Date("2026-10-14T15:00:00Z") });
    const reload = vi.fn();
    respond({ ...dispatchers(NAMES), page: "GrossRacePage-new2.js" });
    render(<GrossRacePage view="dispatchers" ownChunk="GrossRacePage-old1.js" reload={reload} />);
    await screen.findAllByText("Ann Example");
    respond({ ...dispatchers([NAMES[1], NAMES[0], ...NAMES.slice(2)]), page: "GrossRacePage-new2.js" });
    await poll();
    expect(card()).toHaveTextContent("Bo Example");
    expect(reload).not.toHaveBeenCalled();
  });

  test("/dispatch's Test sound shows the card with the chime and says whether sound may start by itself", async () => {
    respond(dispatchers(NAMES));
    const user = userEvent.setup();
    render(<GrossRacePage view="dispatchers" />);
    await screen.findAllByText("Ann Example");
    await user.click(screen.getByRole("button", { name: "Test sound" }));
    expect(card()).toHaveTextContent("Sound test");
    expect(card()).toHaveTextContent("↑ 5th → 3rd");
    expect(card()).toHaveTextContent(/sound by itself: blocked/);
    expect(await screen.findByText(/chime did not play/)).toBeInTheDocument(); // no Web Audio in the test browser
    expect(screen.queryByRole("dialog", { name: "Today's leader" })).not.toBeInTheDocument();
  });
});
