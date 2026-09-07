/**
 * Settings → RingCentral → a recruiter row: "Pick from Bitrix".
 *
 * The Bitrix user id used to be a bare number field, so setting it meant
 * opening the Bitrix profile and reading the id out of the URL. The picker
 * removes that — but it has THREE different answers to keep apart, and the
 * middle one is the trap:
 *
 *   users returned → the dropdown;
 *   an empty list  → say so. An inert button that does nothing when clicked is
 *                    exactly the "empty data shown as if everything is normal"
 *                    failure this panel exists to avoid;
 *   a failed read  → the page already reported why, so do not talk over it.
 */
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RecruiterCard from "./RecruiterCard";

vi.mock("../../../api", () => ({
  updateRecruiter: vi.fn(),
  deleteRecruiter: vi.fn(),
  testRecruiterConnection: vi.fn(),
  diagnoseRecruiter: vi.fn(),
  createRecruiterConnectLink: vi.fn(),
  clearRecruiterRingCentralLogin: vi.fn(),
  sendRecruiterTestSms: vi.fn(),
}));

afterEach(() => { vi.clearAllMocks(); });

const RECRUITER = {
  id: 1, name: "Alex Smith", phone_number: "+15550001111", active: true,
  bitrixUserId: null, authMode: "oauth", canSendSms: true, oauthConnected: true,
};

const USERS = [
  { id: 17, fullName: "Alex Smith", position: "Recruiter", active: true },
  { id: 21, fullName: "Dana Vaughn", position: "", active: false },
];

function open({ bitrixUsers = null, loadBitrixUsers } = {}) {
  const onMessage = vi.fn();
  const view = render(
    <RecruiterCard
      recruiter={RECRUITER}
      onMessage={onMessage}
      bitrixUsers={bitrixUsers}
      loadBitrixUsers={loadBitrixUsers}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
  return { onMessage, view };
}

test("the picker lists Bitrix users, with position and deactivated state", async () => {
  let stored = null;
  const loadBitrixUsers = vi.fn(async () => USERS);
  const { view } = open({ loadBitrixUsers });

  fireEvent.click(screen.getByRole("button", { name: /Pick from Bitrix/i }));
  await waitFor(() => expect(loadBitrixUsers).toHaveBeenCalledTimes(1));

  // The parent owns the list, so re-render with it as the tab would.
  view.rerender(
    <RecruiterCard recruiter={RECRUITER} onMessage={() => {}} bitrixUsers={USERS} loadBitrixUsers={loadBitrixUsers} />
  );
  const select = await screen.findByRole("combobox");
  expect(select).toBeTruthy();
  expect(screen.getByRole("option", { name: /#17 · Alex Smith · Recruiter/ })).toBeTruthy();
  expect(screen.getByRole("option", { name: /#21 · Dana Vaughn · deactivated/ })).toBeTruthy();
  expect(screen.getByRole("option", { name: /no Bitrix user/ })).toBeTruthy();

  fireEvent.change(select, { target: { value: "17" } });
  stored = select.value;
  expect(stored).toBe("17");
});

test("an empty directory is stated, not left as a button that does nothing", async () => {
  const loadBitrixUsers = vi.fn(async () => []);
  const { onMessage } = open({ loadBitrixUsers });

  fireEvent.click(screen.getByRole("button", { name: /Pick from Bitrix/i }));
  await waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
  expect(onMessage.mock.calls[0][0].type).toBe("error");
  expect(onMessage.mock.calls[0][0].text).toMatch(/no users/i);
  expect(onMessage.mock.calls[0][0].text).toMatch(/"user" scope/);
  expect(screen.queryByRole("combobox")).toBeNull();
});

test("a failed read is not talked over — the page already reported it", async () => {
  const loadBitrixUsers = vi.fn(async () => null);
  const { onMessage } = open({ loadBitrixUsers });

  fireEvent.click(screen.getByRole("button", { name: /Pick from Bitrix/i }));
  await waitFor(() => expect(loadBitrixUsers).toHaveBeenCalled());
  expect(onMessage).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox")).toBeNull();
});

test("typing the id by hand still works, and is still explained", async () => {
  open({ loadBitrixUsers: vi.fn(async () => USERS) });
  const field = screen.getByPlaceholderText("e.g. 17");
  fireEvent.change(field, { target: { value: "42" } });
  expect(field.value).toBe("42");
  expect(screen.getByText(/Or type it from the Bitrix profile URL/i)).toBeTruthy();
});

test("with no loader wired the picker is disabled rather than broken", async () => {
  open({ loadBitrixUsers: undefined });
  expect(screen.getByRole("button", { name: /Pick from Bitrix/i }).disabled).toBe(true);
});
