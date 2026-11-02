/**
 * Mileage Bonuses, thinned in November 2026 (docs/redesign/density.md C5): the
 * cards still waiting for a decision first, the decided history collapsed with
 * a count, and the per-driver switch named for what it is — in or out of the
 * bonus program, not Driver Groups' "Active/Inactive".
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import * as api from "../api";
import MileageBonusPage from "./MileageBonusPage";

vi.mock("../api", () => ({
  getMileageBonusOverview: vi.fn(),
  runMileageBonusCheck: vi.fn(),
  refreshMileageBonusProgress: vi.fn(),
  updateMileageBonusDriverStatus: vi.fn(),
  resendMileageBonusNotification: vi.fn(),
  disregardMileageBonusNotification: vi.fn(),
}));

const note = (id, driver, status) => ({
  id, driver_name: driver, threshold_miles: 10000, bonus_amount: 200, miles_at_notification: 10050,
  status, created_at: "2026-10-30T10:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getMileageBonusOverview.mockResolvedValue({
    configured: true, programStart: "2026-04-17",
    tiers: [{ miles: 10000, amount: 200 }],
    progress: [{ driver_name: "John Carter", driver_normalized_name: "john carter", total_miles: 12000, is_active: true, trips: 4 }],
    notifications: [note(1, "John Carter", "pending"), note(2, "Maria Lopez", "paid"), note(3, "Aziz Karimov", "disregarded")],
  });
});

test("what waits for a decision is first; the decided history is folded with a count", async () => {
  render(<MileageBonusPage />);
  expect(await screen.findByText("Waiting for a decision (1)")).toBeTruthy();
  const history = screen.getByText("History (2)").closest("details");
  expect(history.open).toBe(false);
  expect(history.textContent).toMatch(/Maria Lopez/);
  expect(history.textContent).toMatch(/Aziz Karimov/);
  // Resend is still offered on a decided card, inside the history.
  expect(history.querySelectorAll("button").length).toBeGreaterThan(0);
});

test("the per-driver switch says in or out of the bonus program", async () => {
  render(<MileageBonusPage />);
  const select = await screen.findByRole("combobox", { name: "Mileage status for John Carter" });
  expect([...select.options].map((o) => o.textContent)).toEqual(["In bonus program", "Excluded"]);
});

test("excluding a driver asks and reports in the bonus program's words, never 'inactive'", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  api.updateMileageBonusDriverStatus.mockResolvedValue({ cleanedNotifications: [] });
  render(<MileageBonusPage />);
  const select = await screen.findByRole("combobox", { name: "Mileage status for John Carter" });
  fireEvent.change(select, { target: { value: "inactive" } });

  expect(confirm.mock.calls[0][0]).toMatch(/^Exclude John Carter from the bonus program\?/);
  expect(await screen.findByText("John Carter is now excluded from the bonus program.")).toBeTruthy();
  expect(api.updateMileageBonusDriverStatus).toHaveBeenCalledWith("john carter", "inactive");
  confirm.mockRestore();
});
