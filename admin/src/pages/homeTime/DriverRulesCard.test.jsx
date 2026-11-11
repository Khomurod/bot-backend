/**
 * Home Time → drivers' own home-time rules: the list, adding one, removing
 * one, and the old Bitrix exceptions shown — never imported by themselves.
 * Names are made up.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DriverRulesCard from "./DriverRulesCard";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getPolicyExceptions: vi.fn(),
  savePolicyException: vi.fn(),
  removePolicyException: vi.fn(),
  previewBitrixExceptions: vi.fn(),
}));

const DATA = {
  policy: { roadDays: 28, homeDays: 4 },
  groups: [{ id: 5, name: "WENZE UNIT 012", driverName: "Kwame Asante" }],
  exceptions: [{ id: 9, groupId: 5, groupName: "WENZE UNIT 012", roadDays: 21, homeDays: 3, validUntil: null, note: "agreed" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getPolicyExceptions.mockResolvedValue(DATA);
  api.savePolicyException.mockResolvedValue({});
  api.removePolicyException.mockResolvedValue(true);
});

test("lists the rules and saves a new one as typed", async () => {
  render(<DriverRulesCard />);
  expect(await screen.findByText("WENZE UNIT 012")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Driver for the rule"), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText("Days on the road"), { target: { value: "21" } });
  fireEvent.change(screen.getByLabelText("Days at home"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(api.savePolicyException).toHaveBeenCalledWith({
    groupId: "5", roadDays: "21", homeDays: "3", validUntil: "", note: "",
  }));
});

test("removes a rule", async () => {
  render(<DriverRulesCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await waitFor(() => expect(api.removePolicyException).toHaveBeenCalledWith(9));
});

test("the old Bitrix exceptions are listed; Use fills the form, nothing is saved by itself", async () => {
  api.previewBitrixExceptions.mockResolvedValue([
    { dealId: 1, title: "KWAME ASANTE", allowDays: "7", homeUntil: "2026-11-20", agreed: false, groupId: 5, groupName: "WENZE UNIT 012" },
  ]);
  render(<DriverRulesCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Show the old Bitrix exceptions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use" }));
  expect(screen.getByLabelText("Days at home")).toHaveValue(7);
  expect(api.savePolicyException).not.toHaveBeenCalled();
});
