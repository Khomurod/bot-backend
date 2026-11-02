/**
 * Birthdays → Birthdays, laid out in November 2026 (docs/redesign/density.md E3):
 *
 *   - The posting time is one line; Change opens the three fields in place.
 *   - Every send is in one toolbar above the table; the add form opens only
 *     from "Add employee".
 *   - The confirm in front of each send is a real modal dialog: named by its
 *     title, focus on Cancel, Escape cancels, focus returns to the opener.
 *   - "Congratulate selected" posts exactly the rows that were ticked when
 *     the confirm opened.
 */
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../api", () => ({
  getEmployeeBirthdaySettings: vi.fn(),
  getEmployeeBirthdays: vi.fn(),
  updateEmployeeBirthdaySettings: vi.fn(),
  congratulateEmployees: vi.fn(),
  createEmployeeBirthday: vi.fn(),
  deleteEmployeeBirthday: vi.fn(),
  sendEmployeeBirthdayRequest: vi.fn(),
}));

import * as api from "../../api";
import CompanyBirthdaysPage from "../CompanyBirthdaysPage";

const EMPLOYEES = [
  { id: 1, first_name: "Aziz", last_name: "Karimov", birthday: "1990-03-14T00:00:00.000Z" },
  { id: 2, first_name: "Dana", last_name: "Lee", birthday: "1988-11-20T00:00:00.000Z" },
];

function setup() {
  api.getEmployeeBirthdaySettings.mockResolvedValue({ timezone: "Asia/Tashkent", sendHour: 9, sendMinute: 5 });
  api.getEmployeeBirthdays.mockResolvedValue(EMPLOYEES);
  render(<CompanyBirthdaysPage />);
  return screen.findByText("Aziz");
}

afterEach(() => vi.resetAllMocks());

test("the posting time is one line, and Change opens the fields in place", async () => {
  await setup();
  expect(screen.getByText("09:05 Tashkent Time (Asia/Tashkent)")).toBeTruthy();
  expect(screen.queryByLabelText("Timezone")).toBeNull();

  api.updateEmployeeBirthdaySettings.mockResolvedValue({ timezone: "UTC", sendHour: 7, sendMinute: 0 });
  await userEvent.click(screen.getByRole("button", { name: "Change" }));
  await userEvent.selectOptions(screen.getByLabelText("Timezone"), "UTC");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(api.updateEmployeeBirthdaySettings).toHaveBeenCalledWith(
    { timezone: "UTC", sendHour: 9, sendMinute: 5 },
  ));
  expect(await screen.findByText("07:00 UTC (UTC)")).toBeTruthy();
  expect(screen.queryByLabelText("Timezone")).toBeNull();
});

test("the sends sit in one toolbar above the table, and the add form waits for its button", async () => {
  await setup();
  const toolbar = screen.getByRole("toolbar", { name: "Birthday actions" });
  for (const name of [/Send today's wishes now/, /Congratulate selected/, /Custom message/, /Send Telegram Request/, /Add employee/]) {
    expect(within(toolbar).getByRole("button", { name })).toBeTruthy();
  }
  const table = screen.getByRole("table");
  expect(toolbar.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  expect(screen.queryByRole("form", { name: "Add employee" })).toBeNull();
  await userEvent.click(within(toolbar).getByRole("button", { name: /Add employee/ }));
  const form = screen.getByRole("form", { name: "Add employee" });
  expect(within(form).getByLabelText("First Name")).toBeTruthy();
});

test("the confirm is a modal dialog: named, focus on Cancel, Escape cancels and focus returns", async () => {
  await setup();
  const opener = screen.getByRole("button", { name: /Send Telegram Request/ });
  await userEvent.click(opener);

  const dialog = screen.getByRole("dialog", { name: "💬 Request Birthdays?" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.sendEmployeeBirthdayRequest).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(opener);
});

test("Congratulate selected posts exactly the ticked rows", async () => {
  await setup();
  api.congratulateEmployees.mockResolvedValue({ sent: true, names: "Dana Lee" });
  await userEvent.click(screen.getByRole("checkbox", { name: "Select Dana Lee" }));
  await userEvent.click(screen.getByRole("button", { name: "Congratulate selected (1)" }));

  const dialog = screen.getByRole("dialog", { name: "🎂 Congratulate 1 Employee(s)?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.congratulateEmployees).toHaveBeenCalledWith([2]));
  expect(await screen.findByText(/Posted the birthday card\(s\) to the employee group for: Dana Lee/)).toBeTruthy();
});

test("Delete asks, and Remove deletes that one employee", async () => {
  await setup();
  api.deleteEmployeeBirthday.mockResolvedValue({});
  const row = screen.getByText("Aziz").closest("tr");
  await userEvent.click(within(row).getByRole("button", { name: "Delete" }));
  expect(api.deleteEmployeeBirthday).not.toHaveBeenCalled();

  const dialog = screen.getByRole("dialog", { name: "🗑️ Remove Employee?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(api.deleteEmployeeBirthday).toHaveBeenCalledWith(1));
});
