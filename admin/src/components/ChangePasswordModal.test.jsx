/**
 * Changing your own password: current + new twice, and a success that sends
 * you to sign in again (the server has ended this session).
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChangePasswordModal from "./ChangePasswordModal";
import * as api from "../api";

vi.mock("../api", () => ({ changePassword: vi.fn() }));

function fill({ current = "old-password-1", next = "new-password-1", confirm = next } = {}) {
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("New password again"), { target: { value: confirm } });
}

beforeEach(() => { vi.clearAllMocks(); });

test("the button stays off until the new password is long enough, typed twice, and different", () => {
  render(<ChangePasswordModal onClose={vi.fn()} onSignInAgain={vi.fn()} />);
  const submit = screen.getByRole("button", { name: "Change password" });
  fill({ next: "short" });
  expect(submit).toBeDisabled();
  fill({ next: "new-password-1", confirm: "new-password-2" });
  expect(screen.getByText("The two new passwords do not match.")).toBeInTheDocument();
  fill({ current: "same-password-1", next: "same-password-1" });
  expect(screen.getByText("The new password is the same as the current one.")).toBeInTheDocument();
  fill();
  expect(submit).not.toBeDisabled();
});

test("success says every session ended and offers the sign-in screen", async () => {
  api.changePassword.mockResolvedValue({ changed: true, sign_in_again: true });
  const onSignInAgain = vi.fn();
  render(<ChangePasswordModal onClose={vi.fn()} onSignInAgain={onSignInAgain} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));

  await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith("old-password-1", "new-password-1"));
  expect(await screen.findByText(/Every session of this account has ended/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(onSignInAgain).toHaveBeenCalled();
});

test("a wrong current password is shown and nothing else happens", async () => {
  api.changePassword.mockRejectedValue(new Error("Current password is incorrect."));
  const onSignInAgain = vi.fn();
  render(<ChangePasswordModal onClose={vi.fn()} onSignInAgain={onSignInAgain} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));

  expect(await screen.findByText("Current password is incorrect.")).toBeInTheDocument();
  expect(onSignInAgain).not.toHaveBeenCalled();
});

test("focus moves in on open, Tab stays inside, Escape closes, and focus returns to the opener", () => {
  const opener = document.createElement("button");
  opener.textContent = "Change password (sidebar)";
  document.body.appendChild(opener);
  opener.focus();
  const onClose = vi.fn();
  const { unmount } = render(<ChangePasswordModal onClose={onClose} onSignInAgain={vi.fn()} />);

  const currentField = screen.getByLabelText("Current password");
  expect(document.activeElement).toBe(currentField);
  const cancel = screen.getByRole("button", { name: "Cancel" });
  cancel.focus();
  fireEvent.keyDown(cancel, { key: "Tab" });
  expect(document.activeElement).toBe(currentField);
  fireEvent.keyDown(currentField, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(cancel);

  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

test("while the request is in flight it cannot be dismissed, so its result is always seen", async () => {
  let resolve;
  api.changePassword.mockReturnValue(new Promise((r) => { resolve = r; }));
  const onClose = vi.fn();
  render(<ChangePasswordModal onClose={onClose} onSignInAgain={vi.fn()} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));

  expect(await screen.findByRole("button", { name: "Changing…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("dialog").parentElement);
  expect(onClose).not.toHaveBeenCalled();

  resolve({ changed: true, sign_in_again: true });
  expect(await screen.findByText(/Every session of this account has ended/)).toBeInTheDocument();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sign in again" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
});

test("Cancel closes without a request", () => {
  const onClose = vi.fn();
  render(<ChangePasswordModal onClose={onClose} onSignInAgain={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalled();
  expect(api.changePassword).not.toHaveBeenCalled();
});
