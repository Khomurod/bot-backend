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
  setBoardBitrixSync: vi.fn(),
  approveBoardBitrixSchema: vi.fn(),
  runBoardBitrixCheck: vi.fn(),
}));

function view(over = {}) {
  return {
    enabled: true,
    syncMode: "off",
    maxUpdatesPerPass: 10,
    schema: { source: "catalog_exact", confidence: 100, checkedAt: "2026-11-09T15:00:00Z", writeSafe: true },
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

test("shows why a fallback schema blocks writes", async () => {
  api.getBoardBitrixCheck.mockResolvedValue(view({
    schema: {
      source: "static_fallback", confidence: null, checkedAt: "2026-11-09T20:00:00Z",
      writeSafe: false, problem: "Bitrix crm.type.list: access denied for this webhook",
    },
  }));
  render(<BoardBitrixCard />);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Writes are blocked: Bitrix crm.type.list: access denied for this webhook"
  );
  expect(screen.getByText("Schema source").nextSibling).toHaveTextContent("not validated for writes");
});

test("an invalid discovery shows one blocking reason, not duplicate warnings", async () => {
  const candidate = {
    state: "invalid", problem: "selected active stages contain no trucks",
    evidence: { populatedStages: [
      { label: "Available for dispatch", category: "Trucks", itemCount: 104 },
    ] },
  };
  api.getBoardBitrixCheck.mockResolvedValue(view({
    schema: { source: "catalog_exact", writeSafe: false, problem: candidate.problem, candidate },
  }));
  render(<BoardBitrixCard />);
  const warnings = await screen.findAllByRole("status");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toHaveTextContent("Writes and comparison are blocked");
  expect(warnings[0]).toHaveTextContent("Available for dispatch / Trucks (104)");
});

test("shows candidate evidence and approves only a twice-seen structural change", async () => {
  const candidate = {
    state: "candidate", source: "ai_validated", confidence: 95,
    seenCount: 2, requiresApproval: true, readyToApprove: true,
    problem: "the Bitrix structure changed",
    labels: {
      driverPipeline: "4. DRIVER RELATION", truckProcess: "Trucks",
      truckCategory: "On road", activeTruckStages: ["On the road", "Drivers at shops"],
    },
    evidence: { totalTruckItems: 140, selectedCategoryItems: 118, selectedActiveItems: 104 },
  };
  api.getBoardBitrixCheck.mockResolvedValue(view({
    schema: { source: "catalog_exact", writeSafe: false, candidate },
  }));
  api.approveBoardBitrixSchema.mockResolvedValue(view({
    schema: { source: "ai_validated", confidence: 95, writeSafe: true, candidate: null },
  }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<BoardBitrixCard />);
  expect(await screen.findByRole("status")).toHaveTextContent("104 active of 118 items");
  fireEvent.click(screen.getByRole("button", { name: "Approve schema" }));
  await waitFor(() => expect(api.approveBoardBitrixSchema).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/Schema approved/)).toBeInTheDocument();
});

test("switching on says the first check is running", async () => {
  api.getBoardBitrixCheck.mockResolvedValue(view({ enabled: false }));
  api.setBoardBitrixCheckEnabled.mockResolvedValue(view({ enabled: true }));
  render(<BoardBitrixCard />);
  fireEvent.click(await screen.findByLabelText("Board ↔ Bitrix check on"));
  await waitFor(() => expect(api.setBoardBitrixCheckEnabled).toHaveBeenCalledWith(true));
  expect(await screen.findByText(/first check is running now/)).toBeInTheDocument();
});

test("switching off immediately shows the server-enforced sync reset", async () => {
  api.getBoardBitrixCheck.mockResolvedValue(view({ enabled: true, syncMode: "live" }));
  api.setBoardBitrixCheckEnabled.mockResolvedValue(view({ enabled: false, syncMode: "off" }));
  render(<BoardBitrixCard />);
  expect(await screen.findByLabelText("Board Bitrix sync mode")).toHaveValue("live");
  fireEvent.click(screen.getByLabelText("Board ↔ Bitrix check on"));
  await waitFor(() => expect(api.setBoardBitrixCheckEnabled).toHaveBeenCalledWith(false));
  expect(screen.getByLabelText("Board Bitrix sync mode")).toHaveValue("off");
  expect(screen.getByText(/sync mode was reset to Off/)).toBeInTheDocument();
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

test("dry run saves without confirmation; live requires confirmation", async () => {
  api.getBoardBitrixCheck.mockResolvedValue(view());
  api.setBoardBitrixSync.mockResolvedValue(view({ syncMode: "dry_run" }));
  render(<BoardBitrixCard />);
  fireEvent.change(await screen.findByLabelText("Board Bitrix sync mode"), { target: { value: "dry_run" } });
  fireEvent.click(screen.getByRole("button", { name: "Save mode" }));
  await waitFor(() => expect(api.setBoardBitrixSync).toHaveBeenCalledWith({
    syncMode: "dry_run", maxUpdatesPerPass: 10, confirmLive: false,
  }));
  expect(await screen.findByText(/Dry run enabled/)).toBeInTheDocument();

  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  api.setBoardBitrixSync.mockResolvedValue(view({ syncMode: "live" }));
  fireEvent.change(screen.getByLabelText("Board Bitrix sync mode"), { target: { value: "live" } });
  fireEvent.click(screen.getByRole("button", { name: "Save mode" }));
  await waitFor(() => expect(api.setBoardBitrixSync).toHaveBeenLastCalledWith({
    syncMode: "live", maxUpdatesPerPass: 10, confirmLive: true,
  }));
  expect(confirm).toHaveBeenCalledTimes(1);
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
