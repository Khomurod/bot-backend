/**
 * Birthdays on the boards (birthday/; the owner, 6 November 2026): they follow
 * the server's list on both boards, wait for the 4 PM celebration, hold back a
 * climb card and a reload while they are on, and are shown once per tab.
 */
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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
const DRIVER = { key: "driver-42-2026-10-14", kind: "driver", name: "John Smith", subtitle: null, truck: "1109", sentAt: "2026-10-14T13:00:00.000Z", card: null };
const EMPLOYEE = { key: "employee-7-2026-10-14", kind: "employee", name: "Testbek", subtitle: "Tom", truck: null, sentAt: "2026-10-14T12:00:00.000Z", card: "/api/gross-race/birthday-card/employee-7-2026-10-14" };
const answer = (racers, birthdays = [], extra = {}) => ({
  view: "teams", status: "live", error: null, updatedAt: "2026-10-14T18:00:00.000Z", week, targets: { solo: 15000, team: 20000 },
  race: { racers, lead: racers[0].gross, leadPct: 0.75, maxTarget: 60000, topRpmId: null, rankBy: "percent" },
  birthdays, ...extra,
});
const TWO = [team("Ann's Team", 1, 50000), team("Bo's Team", 2, 40000)];
const SWAPPED = [team("Bo's Team", 1, 55000), team("Ann's Team", 2, 50000)];

function respond(body) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
}
const poll = async () => {
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await new Promise((resolve) => setTimeout(resolve, 50));
};
const birthdayDialog = () => screen.queryByRole("dialog", { name: "Happy Birthday" });

afterEach(() => {
  window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("birthdays on the race boards", () => {
  test("on both boards: a driver with the truck, an employee with the card, in the order they went out", async () => {
    for (const view of ["teams", "dispatchers"]) {
      respond({ ...answer(TWO, [EMPLOYEE, DRIVER]), view });
      const { unmount } = render(<GrossRacePage view={view} />);
      expect(await screen.findByRole("img", { name: "Testbek's birthday card" })).toHaveAttribute("src", EMPLOYEE.card);
      unmount();
      window.sessionStorage.clear();
    }
  });

  test("once per tab: the board's own reload does not congratulate again", async () => {
    respond(answer(TWO, [DRIVER]));
    const first = render(<GrossRacePage view="teams" />);
    expect(await screen.findByText("Truck 1109")).toBeInTheDocument();
    first.unmount();
    respond(answer(TWO, [DRIVER]));
    render(<GrossRacePage view="teams" />);
    await screen.findAllByText("Ann's Team");
    await new Promise((resolve) => setTimeout(resolve, 1200)); // a tick of the page's clock
    expect(birthdayDialog()).toBe(null);
  });

  test("the 4 PM celebration goes first", async () => {
    window.history.pushState({}, "", "/dispatchteam?celebrate");
    respond(answer(TWO, [DRIVER]));
    render(<GrossRacePage view="teams" />);
    await screen.findByRole("dialog", { name: "Today's leader" });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(birthdayDialog()).toBe(null);
  });

  test("while a birthday is on, a climb gets its feed line but no card", async () => {
    respond(answer(TWO, [DRIVER]));
    render(<GrossRacePage view="teams" />);
    expect(await screen.findByText("Truck 1109")).toBeInTheDocument();
    respond(answer(SWAPPED, [DRIVER]));
    await poll();
    expect(screen.getByText("Bo's Team takes the lead!")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBe(null);
  });

  test("a newer build waits while a birthday is on", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: new Date("2026-10-14T15:00:00Z") });
    const reload = vi.fn();
    respond(answer(TWO, [DRIVER], { page: "GrossRacePage-new2.js" }));
    render(<GrossRacePage view="teams" ownChunk="GrossRacePage-old1.js" reload={reload} />);
    expect(await screen.findByText("Truck 1109")).toBeInTheDocument();
    await poll(); // the new build named a second time
    await poll();
    expect(reload).not.toHaveBeenCalled();
  });
});
