/**
 * Driver Groups → driver details → "Samsara alerts in this group".
 *
 *   - The state is visible: On / Off, with what each one means.
 *   - Changing it calls the GROUP's endpoint with the group id (not the
 *     profile id), then re-reads the list, so what is shown is what was saved.
 *   - Off is also visible from the table row, without opening the driver.
 *   - A team shares one group, so the help says it applies to both.
 *   - A company chat has no switch: Samsara never posts to one.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../api", () => ({
  getDriverProfiles: vi.fn(),
  getGroupMembers: vi.fn(),
  updateDriverProfile: vi.fn(),
  runDriverProfilesAiSync: vi.fn(),
  setSamsaraDriverAlerts: vi.fn(),
}));

import * as api from "../../api";
import GroupsPage from "../GroupsPage";

const driver = (over = {}) => ({
  id: 11, group_id: 501, group_name: "WENZE UNIT # 101 JOHN CARTER", telegram_group_id: "-100501",
  group_type: "driver", group_active: true, first_name: "John", last_name: "Carter", unit_number: "101",
  status: "active", driver_type: "company_driver", samsara_driver_alerts_enabled: true, ...over,
});

const chat = {
  id: 12, group_id: 502, group_name: "Wenze Dispatch Team", telegram_group_id: "-100502",
  group_type: "employee", group_active: true, status: "active", samsara_driver_alerts_enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getGroupMembers.mockResolvedValue([]);
});

async function openDetails(name) {
  await userEvent.click(await screen.findByRole("button", { name }));
  return screen.getByRole("group", { name: "Samsara alerts in this group" });
}

test("ON is shown as On, and switching it off calls the group endpoint and shows Off after the re-read", async () => {
  api.getDriverProfiles
    .mockResolvedValueOnce([driver()])
    .mockResolvedValue([driver({ samsara_driver_alerts_enabled: false })]);
  api.setSamsaraDriverAlerts.mockResolvedValue({ group_id: 501, samsara_driver_alerts_enabled: false });
  render(<GroupsPage />);

  const section = await openDetails("John Carter");
  const toggle = within(section).getByRole("switch");
  expect(toggle).toBeChecked();
  expect(within(section).getByText("On")).toBeTruthy();
  expect(section.textContent).toMatch(/as well as to the Samsara Notifications group/);

  await userEvent.click(toggle);
  await waitFor(() => expect(api.setSamsaraDriverAlerts).toHaveBeenCalledWith(501, false));
  expect(api.updateDriverProfile).not.toHaveBeenCalled();
  await waitFor(() => expect(within(section).getByRole("switch")).not.toBeChecked());
  expect(within(section).getByText("Off")).toBeTruthy();
  expect(section.textContent).toMatch(/still get every alert/);
  expect(api.getDriverProfiles).toHaveBeenCalledTimes(2);
});

test("OFF is visible from the table row, and switching it back on sends true", async () => {
  api.getDriverProfiles.mockResolvedValue([driver({ samsara_driver_alerts_enabled: false })]);
  api.setSamsaraDriverAlerts.mockResolvedValue({ group_id: 501, samsara_driver_alerts_enabled: true });
  render(<GroupsPage />);

  const row = (await screen.findByRole("button", { name: "John Carter" })).closest("tr");
  expect(row.textContent).toMatch(/Samsara alerts in group: off/);

  const section = await openDetails("John Carter");
  await userEvent.click(within(section).getByRole("switch"));
  await waitFor(() => expect(api.setSamsaraDriverAlerts).toHaveBeenCalledWith(501, true));
});

test("an ON row carries no marker in the table", async () => {
  api.getDriverProfiles.mockResolvedValue([driver()]);
  render(<GroupsPage />);
  const row = (await screen.findByRole("button", { name: "John Carter" })).closest("tr");
  expect(row.textContent).not.toMatch(/Samsara/);
});

test("a team shares the group, so the help says the switch applies to both drivers", async () => {
  api.getDriverProfiles.mockResolvedValue([driver({ secondary_first_name: "Ali", secondary_last_name: "Khan" })]);
  render(<GroupsPage />);
  const section = await openDetails(/John Carter/);
  expect(section.textContent).toMatch(/Team drivers share this group, so this applies to both of them/);
});

test("a team known only from its title (A / B) gets the same note, by the page's own team rule", async () => {
  api.getDriverProfiles.mockResolvedValue([driver({ group_name: "WENZE UNIT # 505 JOHN CARTER / TOM REED" })]);
  render(<GroupsPage />);
  const section = await openDetails("John Carter");
  expect(section.textContent).toMatch(/applies to both of them/);
});

test("a solo driver gets no team note", async () => {
  api.getDriverProfiles.mockResolvedValue([driver()]);
  render(<GroupsPage />);
  const section = await openDetails("John Carter");
  expect(section.textContent).not.toMatch(/Team drivers/);
});

test("an inactive group says Samsara does not post there either way", async () => {
  api.getDriverProfiles.mockResolvedValue([driver({ group_active: false })]);
  render(<GroupsPage />);
  const section = await openDetails("John Carter");
  expect(section.textContent).toMatch(/This group is inactive/);
});

test("a failed save says so and leaves the switch where it was", async () => {
  api.getDriverProfiles.mockResolvedValue([driver()]);
  api.setSamsaraDriverAlerts.mockRejectedValue(new Error("Server error"));
  render(<GroupsPage />);
  const section = await openDetails("John Carter");
  await userEvent.click(within(section).getByRole("switch"));
  expect(await screen.findByText("Server error")).toBeTruthy();
  expect(within(section).getByRole("switch")).toBeChecked();
});

test("a company chat has no Samsara switch", async () => {
  api.getDriverProfiles.mockResolvedValue([driver(), chat]);
  render(<GroupsPage />);
  await userEvent.click(await screen.findByRole("button", { name: "Wenze Dispatch Team" }));
  expect(screen.queryByRole("group", { name: "Samsara alerts in this group" })).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});
