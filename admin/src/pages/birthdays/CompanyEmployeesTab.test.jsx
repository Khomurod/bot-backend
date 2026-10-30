/**
 * Users → Company Employees: the staff list with the American name, the
 * Telegram account and the photo. Made-up names.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CompanyEmployeesTab from "./CompanyEmployeesTab";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getCompanyEmployees: vi.fn(),
  updateCompanyEmployee: vi.fn(),
  confirmCompanyEmployeeTelegram: vi.fn(),
  suggestCompanyEmployeeTelegram: vi.fn(),
  uploadCompanyEmployeePhoto: vi.fn(),
  deleteCompanyEmployeePhoto: vi.fn(),
  getCompanyEmployeeCardUrl: vi.fn(),
}));

const ROWS = [
  {
    id: 1, first_name: "TESTBEK", last_name: "EXAMPLOV", american_name: "Sample Person",
    telegram_username: "sample_person", telegram_user_id: "111", telegram_match: "suggested", has_photo: true,
  },
  {
    id: 2, first_name: "OZOD", last_name: "EXAMPLOV", american_name: null,
    telegram_username: null, telegram_user_id: null, telegram_match: null, has_photo: false,
  },
];

async function open() {
  api.getCompanyEmployees.mockResolvedValue({ employees: ROWS });
  render(<CompanyEmployeesTab />);
  await waitFor(() => expect(screen.getByText("Testbek Examplov")).toBeInTheDocument());
}

beforeEach(() => { vi.clearAllMocks(); });

test("every employee is listed with what is missing counted", async () => {
  await open();
  expect(screen.getByText("Ozod Examplov")).toBeInTheDocument();
  expect(screen.getByText(/2 employees · 1 without Telegram · 1 to check · 1 without photo/)).toBeInTheDocument();
  expect(screen.getByText("Suggested — check")).toBeInTheDocument();
  expect(screen.getByLabelText("American name for Testbek Examplov")).toHaveValue("Sample Person");
});

test("a suggested account can be confirmed as it is", async () => {
  api.confirmCompanyEmployeeTelegram.mockResolvedValue({});
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.confirmCompanyEmployeeTelegram).toHaveBeenCalledWith(1));
});

test("Save sends what was typed, and is enabled only after a change", async () => {
  api.updateCompanyEmployee.mockResolvedValue({});
  await open();
  const save = screen.getAllByRole("button", { name: "Save" })[1];
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("American name for Ozod Examplov"), { target: { value: "Quinn" } });
  fireEvent.change(screen.getByLabelText("Telegram username for Ozod Examplov"), { target: { value: "@quinn_x" } });
  fireEvent.click(save);
  await waitFor(() => expect(api.updateCompanyEmployee).toHaveBeenCalledWith(2, {
    americanName: "Quinn", telegramUsername: "@quinn_x", telegramUserId: "",
  }));
});

test("Suggest Telegram accounts reports how many were suggested", async () => {
  api.suggestCompanyEmployeeTelegram.mockResolvedValue({ suggested: 3, employees: ROWS });
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Suggest Telegram accounts" }));
  await waitFor(() => expect(screen.getByText(/3 Telegram account\(s\) suggested/)).toBeInTheDocument());
});

test("a chosen photo is uploaded for that employee", async () => {
  api.uploadCompanyEmployeePhoto.mockResolvedValue({ ok: true });
  await open();
  const file = new File(["img"], "face.jpg", { type: "image/jpeg" });
  fireEvent.change(screen.getByLabelText("Photo for Ozod Examplov"), { target: { files: [file] } });
  await waitFor(() => expect(api.uploadCompanyEmployeePhoto).toHaveBeenCalledWith(2, file));
});

test("Card shows the birthday card as it would be posted", async () => {
  api.getCompanyEmployeeCardUrl.mockResolvedValue("blob:card-1");
  await open();
  fireEvent.click(screen.getAllByRole("button", { name: "Card" })[0]);
  await waitFor(() => expect(screen.getByAltText("Birthday card for Testbek")).toHaveAttribute("src", "blob:card-1"));
});

test("reloading after one row is saved keeps what was typed in another", async () => {
  api.updateCompanyEmployee.mockResolvedValue({});
  await open();
  fireEvent.change(screen.getByLabelText("American name for Ozod Examplov"), { target: { value: "Quinn" } });
  fireEvent.change(screen.getByLabelText("American name for Testbek Examplov"), { target: { value: "Sample P." } });
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
  await waitFor(() => expect(api.getCompanyEmployees).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText("American name for Ozod Examplov")).toHaveValue("Quinn");
});
