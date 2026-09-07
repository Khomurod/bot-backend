/**
 * Settings → RingCentral → a recruiter row: saving a Bitrix id, and the
 * "Check Bitrix user" button.
 *
 * Two guarantees this pins:
 *
 *   ① Save must REFUSE a non-numeric id (a pasted URL that didn't parse, a
 *      typo, a name) instead of sending it — the server would coerce it to
 *      null and clear the mapping while reporting success, which is exactly
 *      the "it won't save" bug an operator sees.
 *   ② A pasted profile URL is accepted, cleaned to its number, and saved.
 *   ③ "Check Bitrix user" confirms the id is a real person before saving, and
 *      names the fixable reason when it can't (no user scope, no such id).
 */
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RecruiterCard from "./RecruiterCard";
import { updateRecruiter, checkBitrixUser } from "../../../api";

vi.mock("../../../api", () => ({
  updateRecruiter: vi.fn(),
  deleteRecruiter: vi.fn(),
  testRecruiterConnection: vi.fn(),
  diagnoseRecruiter: vi.fn(),
  createRecruiterConnectLink: vi.fn(),
  clearRecruiterRingCentralLogin: vi.fn(),
  sendRecruiterTestSms: vi.fn(),
  checkBitrixUser: vi.fn(),
}));

afterEach(() => { vi.clearAllMocks(); });

const RECRUITER = {
  id: 1, name: "Alex Smith", phone_number: "+15550001111", active: true,
  bitrixUserId: null, authMode: "oauth", canSendSms: true, oauthConnected: true,
};

function open() {
  const onMessage = vi.fn();
  const onSaved = vi.fn(async () => {});
  render(<RecruiterCard recruiter={RECRUITER} onMessage={onMessage} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
  const field = screen.getByPlaceholderText("e.g. 17");
  return { onMessage, onSaved, field };
}

// ─── ① save refuses a bad id instead of silently clearing it ───

test("saving a non-numeric id is refused, and nothing is sent", async () => {
  const { onMessage, field } = open();
  fireEvent.change(field, { target: { value: "Tom Robinson" } });
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

  await waitFor(() => expect(onMessage).toHaveBeenCalled());
  expect(onMessage.mock.calls[0][0].type).toBe("error");
  expect(onMessage.mock.calls[0][0].text).toMatch(/not a Bitrix user id/);
  expect(updateRecruiter).not.toHaveBeenCalled();
});

// ─── ② a pasted URL is cleaned and saved ───

test("a pasted profile URL is cleaned to its number and saved", async () => {
  updateRecruiter.mockResolvedValue({ recruiter: { ...RECRUITER, bitrixUserId: 17 } });
  const { field } = open();
  fireEvent.change(field, { target: { value: "/company/personal/user/17/" } });
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

  await waitFor(() => expect(updateRecruiter).toHaveBeenCalled());
  expect(updateRecruiter.mock.calls[0][1].bitrixUserId).toBe("17");
  expect(field.value).toBe("17");
});

// ─── ③ the check button ───

test("a confirmed id shows who it belongs to", async () => {
  checkBitrixUser.mockResolvedValue({
    ok: true, found: true,
    user: { id: 17, fullName: "Alex Smith", position: "Recruiter", active: true },
  });
  const { field } = open();
  fireEvent.change(field, { target: { value: "17" } });
  fireEvent.click(screen.getByRole("button", { name: /Check Bitrix user/i }));

  expect(await screen.findByText(/✓ #17 — Alex Smith · Recruiter/)).toBeTruthy();
  expect(checkBitrixUser).toHaveBeenCalledWith("17");
});

test("a check cleans a pasted URL before asking Bitrix", async () => {
  checkBitrixUser.mockResolvedValue({ ok: true, found: true, user: { id: 17, fullName: "Alex Smith", active: true } });
  const { field } = open();
  fireEvent.change(field, { target: { value: "/company/personal/user/17/" } });
  fireEvent.click(screen.getByRole("button", { name: /Check Bitrix user/i }));

  await waitFor(() => expect(checkBitrixUser).toHaveBeenCalledWith("17"));
  expect(field.value).toBe("17");
});

test("an id nobody has is reported as not existing, not as an error", async () => {
  checkBitrixUser.mockResolvedValue({ ok: true, found: false, user: null });
  const { field } = open();
  fireEvent.change(field, { target: { value: "999" } });
  fireEvent.click(screen.getByRole("button", { name: /Check Bitrix user/i }));

  expect(await screen.findByText(/No Bitrix user #999 exists/)).toBeTruthy();
});

test("a webhook without the user scope is named as the fix", async () => {
  checkBitrixUser.mockResolvedValue({ ok: false, found: false, message: 'add the "user" scope to the inbound webhook' });
  const { field } = open();
  fireEvent.change(field, { target: { value: "17" } });
  fireEvent.click(screen.getByRole("button", { name: /Check Bitrix user/i }));

  expect(await screen.findByText(/"user" scope/)).toBeTruthy();
  expect(updateRecruiter).not.toHaveBeenCalled();
});

test("checking an empty field asks for an id instead of calling Bitrix", async () => {
  open();
  fireEvent.click(screen.getByRole("button", { name: /Check Bitrix user/i }));

  expect(await screen.findByText(/Enter a Bitrix user id first/)).toBeTruthy();
  expect(checkBitrixUser).not.toHaveBeenCalled();
});
