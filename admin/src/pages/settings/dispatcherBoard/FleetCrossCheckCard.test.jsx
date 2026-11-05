/**
 * Settings → Dispatcher Board → Compare with Wenze and Datatruck: nothing is
 * read until Compare is pressed; the counts, the rows that differ, and a
 * Datatruck that was not read said plainly.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import FleetCrossCheckCard from "./FleetCrossCheckCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({ getFleetCrossCheck: vi.fn() }));

function report(over = {}) {
  return {
    builtAt: "2026-11-05T12:00:00Z",
    datatruck: { read: true, orderDays: 7 },
    summary: {
      boardRows: 2, allAgree: 1, notInWenze: 1, fleetDiffersWenze: 0, nameDiffersWenze: 0, nameCloseWenze: 0,
      datatruckRead: true, notInDatatruck: 1, fleetDiffersDatatruck: 0, nameDiffersDatatruck: 0,
    },
    rows: [
      {
        truck: "313 COMP", unit: "313", board: { fleetType: "company", names: ["ONESIAS FLENCH"] },
        wenze: { holders: [{ fleetType: "company", name: "ONESIAS FLENCH" }], otherFleets: [], name: "same" },
        datatruck: { read: true, label: "313 COMP", drivers: ["Onesias Flench"], driverTypes: ["company_driver"] },
        problems: [],
      },
      {
        truck: "016 COMP", unit: "016", board: { fleetType: "company", names: ["NEW DRIVER"] },
        wenze: { holders: [], otherFleets: [], name: null },
        datatruck: { read: true, label: null, drivers: [], driverTypes: [] },
        problems: ["not_in_wenze", "not_in_datatruck"],
      },
    ],
    ...over,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

test("nothing is read until Compare is pressed; then only what differs is listed", async () => {
  api.getFleetCrossCheck.mockResolvedValue(report());
  render(<FleetCrossCheckCard />);
  expect(api.getFleetCrossCheck).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Compare"));
  expect(await screen.findByText("Board trucks")).toBeInTheDocument();
  expect(api.getFleetCrossCheck).toHaveBeenCalledWith({ refresh: false });
  expect(screen.getByText("Not in Wenze").nextSibling).toHaveTextContent("1");
  expect(screen.getByText("016 COMP")).toBeInTheDocument();
  expect(screen.getByText(/Not in Wenze; No load in Datatruck this week/)).toBeInTheDocument();
  expect(screen.queryByText("313 COMP")).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Only trucks where something differs"));
  expect(screen.getByText("313 COMP")).toBeInTheDocument();
});

test("a Datatruck that was not read is said, and the Wenze half is still shown", async () => {
  api.getFleetCrossCheck.mockResolvedValue(report({
    datatruck: { read: false, reason: "Datatruck is not connected (no token in Settings → Secrets)." },
    summary: { ...report().summary, datatruckRead: false },
  }));
  render(<FleetCrossCheckCard />);
  fireEvent.click(screen.getByText("Compare"));
  expect(await screen.findByText(/Datatruck is not connected/)).toBeInTheDocument();
  expect(screen.queryByText("No load in Datatruck this week")).not.toBeInTheDocument();
});

test("pressing again asks for a fresh build and shows why it was not rebuilt", async () => {
  api.getFleetCrossCheck.mockResolvedValueOnce(report());
  api.getFleetCrossCheck.mockResolvedValueOnce(report({ refreshRefused: "Built less than 10 minutes ago — Datatruck is not asked again yet." }));
  render(<FleetCrossCheckCard />);
  fireEvent.click(screen.getByText("Compare"));
  fireEvent.click(await screen.findByText("Compare again"));
  expect(await screen.findByText(/not asked again yet/)).toBeInTheDocument();
  expect(api.getFleetCrossCheck).toHaveBeenLastCalledWith({ refresh: true });
});
