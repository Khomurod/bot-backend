/**
 * Every send on the Birthdays tab asks first (November 2026 audit).
 *
 * "Send Telegram Request" posts to the whole employee group. Its confirm text
 * was written, but the button called the send directly, so the dialog could
 * never open — one click posted. It now asks like the other three sends here.
 */
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  getEmployeeBirthdaySettings: vi.fn().mockResolvedValue({ timezone: "Asia/Tashkent", sendHour: 9, sendMinute: 0 }),
  getEmployeeBirthdays: vi.fn().mockResolvedValue([]),
  sendEmployeeBirthdayRequest: vi.fn().mockResolvedValue({}),
}));

import * as api from "../api";
import CompanyBirthdaysPage from "./CompanyBirthdaysPage";

afterEach(() => vi.clearAllMocks());

test("Send Telegram Request asks before posting to the employee group", async () => {
  render(<CompanyBirthdaysPage />);
  await waitFor(() => expect(api.getEmployeeBirthdays).toHaveBeenCalled());

  await userEvent.click(screen.getByRole("button", { name: /Send Telegram Request/ }));
  expect(api.sendEmployeeBirthdayRequest).not.toHaveBeenCalled();
  expect(screen.getByText(/asking all employees for their birthdays/)).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.sendEmployeeBirthdayRequest).toHaveBeenCalledTimes(1));
});

test("Cancel sends nothing", async () => {
  render(<CompanyBirthdaysPage />);
  await waitFor(() => expect(api.getEmployeeBirthdays).toHaveBeenCalled());

  await userEvent.click(screen.getByRole("button", { name: /Send Telegram Request/ }));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.sendEmployeeBirthdayRequest).not.toHaveBeenCalled();
  expect(screen.queryByText(/asking all employees for their birthdays/)).toBeNull();
});
