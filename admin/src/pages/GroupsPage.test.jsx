/**
 * Driver Groups, thinned in November 2026 (docs/redesign/density.md C1):
 * each row leads with the driver, the group title is a grey line under the
 * name, a search box filters the open view in the browser, a company chat has
 * no driver type or unit controls, and the AI pass is a secondary button.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import * as api from "../api";
import GroupsPage from "./GroupsPage";
import { matchesSearch } from "./groups/driverProfileShaping";

vi.mock("../api", () => ({
  getDriverProfiles: vi.fn(),
  getGroupMembers: vi.fn(),
  updateDriverProfile: vi.fn(),
  runDriverProfilesAiSync: vi.fn(),
}));

const driver = (id, first, last, unit, over = {}) => ({
  id, group_id: id, group_name: `WENZE UNIT # ${unit} ${first.toUpperCase()} ${last.toUpperCase()}`,
  group_type: "driver", first_name: first, last_name: last, unit_number: unit, status: "active",
  driver_type: "company_driver", active: true, status_source: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getDriverProfiles.mockResolvedValue([
    driver(1, "John", "Carter", "101"),
    driver(2, "Maria", "Lopez", "202", { status_source: "manual" }),
    { id: 3, group_id: 3, group_name: "Wenze Dispatch Team", group_type: "employee", status: "active", active: true },
  ]);
});

test("a row leads with the driver; the group title is the grey line under it", async () => {
  render(<GroupsPage />);
  const name = await screen.findByRole("button", { name: "John Carter" });
  const cell = name.closest("td");
  expect(cell.textContent).toMatch(/WENZE UNIT # 101 JOHN CARTER/);
  // "via" only when a source is known.
  expect(cell.textContent).not.toMatch(/via/);
  expect(screen.getByRole("button", { name: "Maria Lopez" }).closest("td").textContent).toMatch(/via Manual/);
  expect(screen.queryByRole("columnheader", { name: "Group Name" })).toBeNull();
});

test("the search keeps only the rows that match, in the open view", async () => {
  render(<GroupsPage />);
  await screen.findByRole("button", { name: "John Carter" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search driver groups" }), { target: { value: "202" } });
  expect(screen.queryByRole("button", { name: "John Carter" })).toBeNull();
  expect(screen.getByRole("button", { name: "Maria Lopez" })).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search driver groups" }), { target: { value: "nobody" } });
  expect(screen.getByText(/Nothing in this view matches/)).toBeTruthy();
});

test("a company chat has no driver type or unit controls", async () => {
  render(<GroupsPage />);
  const chat = await screen.findByRole("button", { name: "Wenze Dispatch Team" });
  const row = chat.closest("tr");
  expect(within(row).queryByRole("combobox", { name: /Driver type/ })).toBeNull();
  expect(within(row).queryByRole("textbox", { name: /Unit/ })).toBeNull();
  // Its status is still editable.
  expect(within(row).getByRole("combobox", { name: /Status/ })).toBeTruthy();
  const john = screen.getByRole("button", { name: "John Carter" }).closest("tr");
  expect(within(john).getByRole("combobox", { name: /Driver type/ })).toBeTruthy();
});

test("the AI pass is a secondary button, not the page's primary action", async () => {
  render(<GroupsPage />);
  const ai = await screen.findByRole("button", { name: /AI: enrich/ });
  expect(ai.className).toMatch(/btn-ghost/);
  expect(ai.className).not.toMatch(/btn-primary/);
});

test("matchesSearch reads names, the group title, the unit and @username", () => {
  const p = { first_name: "Aziz", last_name: "Karimov", group_name: "WENZE UNIT # 303", unit_number: "303", telegram_username: "aziz_k" };
  for (const q of ["aziz", "KARIMOV", "303", "aziz_k", ""]) expect(matchesSearch(p, q)).toBe(true);
  expect(matchesSearch(p, "carter")).toBe(false);
});
