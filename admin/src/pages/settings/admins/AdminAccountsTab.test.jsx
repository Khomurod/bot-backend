/**
 * Settings → Administration → Admin Accounts: list, create, disable, reset.
 * Made-up names throughout.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AdminAccountsTab from "./AdminAccountsTab";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getAdminUsers: vi.fn(),
  getAdminRoles: vi.fn(),
  verifyAuth: vi.fn(),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
}));

const ROLES = [
  { id: 1, system_key: "super_admin", display_name: "Super administrator", description: "Everything", active: true },
  { id: 2, system_key: "custom_office", display_name: "Office", description: "Daily work", active: true },
  { id: 3, system_key: "custom_old", display_name: "Old role", active: false },
];
const USERS = [
  { id: 10, username: "owner", active: true, last_login_at: null, roles: [{ id: 1, display_name: "Super administrator" }] },
  { id: 11, username: "dispatcher.anna", active: true, last_login_at: null, roles: [{ id: 2, display_name: "Office" }] },
  { id: 12, username: "former.staff", active: false, last_login_at: null, roles: [{ id: 2, display_name: "Office" }] },
];

function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function open() {
  render(<AdminAccountsTab />);
  await screen.findByRole("table");
}

const rowOf = (name) => screen.getByText(name).closest("tr");

beforeEach(() => {
  vi.clearAllMocks();
  api.getAdminUsers.mockResolvedValue(USERS);
  api.getAdminRoles.mockResolvedValue(ROLES);
  api.verifyAuth.mockResolvedValue({ user: { id: 10, username: "owner" } });
});
afterEach(() => { vi.restoreAllMocks(); });

test("every account is listed with its roles and state; your own row has no actions", async () => {
  await open();
  expect(within(rowOf("dispatcher.anna")).getByText("Office")).toBeInTheDocument();
  expect(within(rowOf("former.staff")).getByText("Disabled")).toBeInTheDocument();
  const own = rowOf("owner");
  expect(within(own).getByText("(you)")).toBeInTheDocument();
  expect(within(own).queryByRole("button", { name: "Disable" })).toBeNull();
  expect(within(own).getByText(/Change password in the sidebar/)).toBeInTheDocument();
});

test("an account without users.manage is told why, not shown an error", async () => {
  api.getAdminUsers.mockRejectedValue(apiError(403, "Forbidden"));
  render(<AdminAccountsTab />);
  expect(await screen.findByText(/needs the/)).toBeInTheDocument();
  expect(screen.getByText("users.manage")).toBeInTheDocument();
});

test("Create stays off until the form is valid, then sends the trimmed name, password and roles", async () => {
  api.createAdminUser.mockResolvedValue({ id: 13, username: "new.person" });
  await open();
  const form = screen.getByRole("form", { name: "New admin account" });
  const create = within(form).getByRole("button", { name: "Create account" });
  expect(create).toBeDisabled();
  // A disabled role is not offered.
  expect(within(form).queryByText("Old role")).toBeNull();

  fireEvent.change(within(form).getByLabelText("Username"), { target: { value: "  new.person " } });
  fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "long-enough-1" } });
  fireEvent.change(within(form).getByLabelText("Password again"), { target: { value: "long-enough-2" } });
  expect(within(form).getByText("The two passwords do not match.")).toBeInTheDocument();
  fireEvent.change(within(form).getByLabelText("Password again"), { target: { value: "long-enough-1" } });
  expect(create).toBeDisabled();
  fireEvent.click(within(form).getByRole("checkbox", { name: /Office/ }));
  expect(create).not.toBeDisabled();

  fireEvent.click(create);
  await waitFor(() => expect(api.createAdminUser).toHaveBeenCalledWith({
    username: "new.person", password: "long-enough-1", roleIds: [2],
  }));
  await waitFor(() => expect(api.getAdminUsers).toHaveBeenCalledTimes(2));
});

test("Disable asks first; the server's refusal (last super administrator) is shown", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  api.updateAdminUser.mockRejectedValue(apiError(409, "The last active super administrator cannot be deactivated."));
  await open();

  fireEvent.click(within(rowOf("dispatcher.anna")).getByRole("button", { name: "Disable" }));

  expect(window.confirm.mock.calls[0][0]).toMatch(/Disable dispatcher.anna\? They are signed out/);
  await waitFor(() => expect(api.updateAdminUser).toHaveBeenCalledWith(11, { active: false }));
  // Shown under the row that was pressed, not in a banner above a long list.
  const refusal = await within(screen.getByRole("table")).findByRole("alert");
  expect(refusal).toHaveTextContent("The last active super administrator cannot be deactivated.");
});

test("a refused create is shown beside the form and cleared when a field changes", async () => {
  api.createAdminUser.mockRejectedValue(apiError(409, "That username is already taken."));
  await open();
  const form = screen.getByRole("form", { name: "New admin account" });
  fireEvent.change(within(form).getByLabelText("Username"), { target: { value: "dispatcher.anna" } });
  fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "long-enough-1" } });
  fireEvent.change(within(form).getByLabelText("Password again"), { target: { value: "long-enough-1" } });
  fireEvent.click(within(form).getByRole("checkbox", { name: /Office/ }));
  fireEvent.click(within(form).getByRole("button", { name: "Create account" }));

  expect(await within(form).findByRole("alert")).toHaveTextContent("That username is already taken.");
  fireEvent.change(within(form).getByLabelText("Username"), { target: { value: "anna.second" } });
  expect(within(form).queryByRole("alert")).toBeNull();
});

test("a disabled account can be enabled again", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  api.updateAdminUser.mockResolvedValue({ id: 12, active: true });
  await open();
  fireEvent.click(within(rowOf("former.staff")).getByRole("button", { name: "Enable" }));
  await waitFor(() => expect(api.updateAdminUser).toHaveBeenCalledWith(12, { active: true }));
  expect(await screen.findByText("former.staff can sign in again.")).toBeInTheDocument();
});

test("Reset password needs the new password twice, then sets it", async () => {
  api.updateAdminUser.mockResolvedValue({ id: 11 });
  await open();
  fireEvent.click(within(rowOf("dispatcher.anna")).getByRole("button", { name: "Reset password" }));
  const form = screen.getByRole("form", { name: "Reset password for dispatcher.anna" });
  const set = within(form).getByRole("button", { name: "Set password" });

  fireEvent.change(within(form).getByLabelText("New password"), { target: { value: "short" } });
  expect(set).toBeDisabled();
  fireEvent.change(within(form).getByLabelText("New password"), { target: { value: "a-new-password" } });
  fireEvent.change(within(form).getByLabelText("New password again"), { target: { value: "a-new-password" } });
  fireEvent.click(set);

  await waitFor(() => expect(api.updateAdminUser).toHaveBeenCalledWith(11, { password: "a-new-password" }));
  expect(await screen.findByText(/password was reset. Their open sessions have ended/)).toBeInTheDocument();
});
