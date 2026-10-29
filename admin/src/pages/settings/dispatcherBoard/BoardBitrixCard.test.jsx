/**
 * Settings → Dispatcher Board → Board ↔ Bitrix check: the switch, the counts,
 * "check now" — and no driver name or truck number anywhere on the card.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import BoardBitrixCard from "./BoardBitrixCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getBoardBitrixCheck: vi.fn(),
  setBoardBitrixCheckEnabled: vi.fn(),
  runBoardBitrixCheck: vi.fn(),
}));

function view(over = {}) {
  return {
    enabled: true,
    counts: { waiting: 4, skipped: 1, asked: 1, confirmed: 2, fixedWithoutReply: 3 },
    byKind: [{ kind: "fleet_missing", label: "Driver type not set in Bitrix", count: 3 }],
    current: { kind: "truck_differs", label: "Different truck", askedAt: "2026-10-29T15:00:00Z" },
    lastRun: { finishedAt: "2026-10-29T15:00:00Z", status: "ok", boardDrivers: 110, activeDeals: 121, activeTrucks: 109, paired: 104, differences: 9 },
    ...over,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

test("shows the switch, the question out, the counts and the last check — counts only", async () => {
  api.getBoardBitrixCheck.mockResolvedValue(view());
  render(<BoardBitrixCard />);
  expect(await screen.findByText("Check is ON")).toBeInTheDocument();
  expect(screen.getByText(/Different truck \(since/)).toBeInTheDocument();
  expect(screen.getByText("Waiting to be asked").nextSibling).toHaveTextContent("4");
  expect(screen.getByText(/Driver type not set in Bitrix 3/)).toBeInTheDocument();
  expect(screen.getByText("Differences found").nextSibling).toHaveTextContent("9");
});

test("switching on says the first check is running; off says nothing more will be asked", async () => {
  api.getBoardBitrixCheck.mockResolvedValue(view({ enabled: false }));
  api.setBoardBitrixCheckEnabled.mockResolvedValue(view({ enabled: true }));
  render(<BoardBitrixCard />);
  fireEvent.click(await screen.findByLabelText("Board ↔ Bitrix check on"));
  await waitFor(() => expect(api.setBoardBitrixCheckEnabled).toHaveBeenCalledWith(true));
  expect(await screen.findByText(/first check is running now/)).toBeInTheDocument();
});

test("check now reports the outcome, and is disabled while the check is off", async () => {
  api.getBoardBitrixCheck.mockResolvedValue(view());
  api.runBoardBitrixCheck.mockResolvedValue({ summary: { discrepancies: 7 }, settings: view() });
  render(<BoardBitrixCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Check now" }));
  expect(await screen.findByText("Checked: 7 difference(s).")).toBeInTheDocument();

  api.getBoardBitrixCheck.mockResolvedValue(view({ enabled: false }));
  render(<BoardBitrixCard />);
  await screen.findByText("Check is OFF");
  expect(screen.getAllByRole("button", { name: "Check now" }).at(-1)).toBeDisabled();
});

test("a failed read shows the failure and a retry, never a switch drawn from defaults", async () => {
  api.getBoardBitrixCheck.mockRejectedValueOnce(new Error("Database unavailable"));
  render(<BoardBitrixCard />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
  expect(screen.queryByLabelText("Board ↔ Bitrix check on")).not.toBeInTheDocument();
  api.getBoardBitrixCheck.mockResolvedValue(view());
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Check is ON")).toBeInTheDocument();
});
