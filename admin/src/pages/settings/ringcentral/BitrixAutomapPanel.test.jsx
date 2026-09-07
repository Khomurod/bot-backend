/**
 * Settings → RingCentral → Bitrix24: "Match recruiters to Bitrix users".
 *
 * The mapping decides whose RingCentral number texts a driver, so the panel's
 * job is as much refusal as it is convenience. These tests pin the two safety
 * properties a careless click could break:
 *
 *   ① the first click PREVIEWS — nothing is written until Apply;
 *   ② a first-name-only guess arrives UNCHECKED, so Apply cannot quietly map
 *     "Alex" the recruiter to "Alex" in accounting.
 *
 * Plus: a directory that cannot be read has to say what to do about it, and
 * the cases the panel refused must be visible rather than silently dropped.
 */
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import BitrixAutomapPanel from "./BitrixAutomapPanel";
import { automapRecruiterBitrixUsers } from "../../../api";

vi.mock("../../../api", () => ({
  automapRecruiterBitrixUsers: vi.fn(),
}));

afterEach(() => { vi.clearAllMocks(); });

const PLAN = {
  ok: true,
  bitrixUsers: 3,
  recruiters: 3,
  apply: [{ recruiterId: 1, recruiterName: "Alex Smith", bitrixUserId: 17, bitrixUserName: "Alex Smith", via: "phone" }],
  propose: [{ recruiterId: 2, recruiterName: "Dana", bitrixUserId: 21, bitrixUserName: "Dana Vaughn", via: "first_name" }],
  ambiguous: [{
    recruiterId: 4, recruiterName: "Sam Ray",
    candidates: [{ bitrixUserId: 31, bitrixUserName: "Sam Ray" }, { bitrixUserId: 32, bitrixUserName: "Sam Ray" }],
  }],
  conflicts: [{ recruiterId: 5, recruiterName: "Kim Lee", reason: "Bitrix user already mapped to Alex Smith" }],
  alreadyMapped: [{
    recruiterId: 3, recruiterName: "Chris Green", bitrixUserId: 77,
    mismatch: { via: "phone", bitrixUserId: 78, bitrixUserName: "C. Green" },
  }],
  unmatched: [{ recruiterId: 6, recruiterName: "Nobody Here" }],
};

const matchButton = () => screen.getByRole("button", { name: /Match recruiters to Bitrix users/i });
const applyButton = () => screen.getByRole("button", { name: /Apply \d+ mapping/i });

async function preview(plan = PLAN) {
  automapRecruiterBitrixUsers.mockResolvedValueOnce(plan);
  render(<BitrixAutomapPanel />);
  fireEvent.click(matchButton());
  await waitFor(() => expect(automapRecruiterBitrixUsers).toHaveBeenCalled());
}

test("the first click previews and writes nothing", async () => {
  await preview();
  expect(automapRecruiterBitrixUsers).toHaveBeenCalledWith({});
  expect(automapRecruiterBitrixUsers).toHaveBeenCalledTimes(1);
  await screen.findByText(/Will map 1 recruiter/i);
});

test("Apply writes only the strong match while a first-name guess stays unchecked", async () => {
  await preview();
  const checkbox = await screen.findByRole("checkbox");
  expect(checkbox.checked).toBe(false);

  // The button counts only what would actually be written.
  expect(applyButton().textContent).toMatch(/Apply 1 mapping/);

  automapRecruiterBitrixUsers.mockResolvedValueOnce({ ...PLAN, applied: PLAN.apply, failed: [] });
  fireEvent.click(applyButton());
  await waitFor(() => expect(automapRecruiterBitrixUsers).toHaveBeenCalledTimes(2));
  expect(automapRecruiterBitrixUsers).toHaveBeenLastCalledWith({ apply: true, confirm: [] });
});

test("confirming a first-name guess includes exactly that recruiter", async () => {
  await preview();
  fireEvent.click(await screen.findByRole("checkbox"));
  expect(applyButton().textContent).toMatch(/Apply 2 mappings/);

  automapRecruiterBitrixUsers.mockResolvedValueOnce({ ...PLAN, applied: PLAN.apply, failed: [] });
  fireEvent.click(applyButton());
  await waitFor(() => expect(automapRecruiterBitrixUsers).toHaveBeenCalledTimes(2));
  // The PAIR, not just the recruiter: apply re-reads the directory, so the
  // request has to name the Bitrix user the operator actually looked at.
  expect(automapRecruiterBitrixUsers).toHaveBeenLastCalledWith({
    apply: true,
    confirm: [{ recruiterId: 2, bitrixUserId: 21 }],
  });
});

test("everything the matcher refused is shown, not silently dropped", async () => {
  await preview();
  expect(await screen.findByText(/#31 Sam Ray, #32 Sam Ray/)).toBeTruthy();
  expect(screen.getByText(/already mapped to Alex Smith/i)).toBeTruthy();
  expect(screen.getByText(/No Bitrix user found for 1 recruiter/i)).toBeTruthy();
  expect(screen.getByText(/matches #78/)).toBeTruthy();
});

test("a deactivated Bitrix user is flagged before it is written", async () => {
  await preview({
    ...PLAN,
    propose: [], ambiguous: [], conflicts: [], alreadyMapped: [], unmatched: [],
    apply: [{ ...PLAN.apply[0], bitrixUserActive: false }],
  });
  expect(await screen.findByText(/that Bitrix user is deactivated/i)).toBeTruthy();
});

test("an unreadable directory says what to do and offers no Apply", async () => {
  await preview({
    ok: false,
    reason: "no_user_scope",
    message: 'The Bitrix webhook cannot read the user directory. Regenerate the inbound webhook with the "user" scope',
    detail: "Access denied",
  });
  expect(await screen.findByText(/"user" scope/)).toBeTruthy();
  expect(screen.getByText(/Access denied/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Apply/i })).toBeNull();
});

test("a mapped result refreshes the recruiter rows", async () => {
  const onMapped = vi.fn();
  automapRecruiterBitrixUsers.mockResolvedValueOnce(PLAN);
  render(<BitrixAutomapPanel onMapped={onMapped} />);
  fireEvent.click(matchButton());
  await screen.findByText(/Will map 1 recruiter/i);

  automapRecruiterBitrixUsers.mockResolvedValueOnce({ ...PLAN, applied: PLAN.apply, failed: [] });
  fireEvent.click(applyButton());
  await waitFor(() => expect(onMapped).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/Mapped 1 recruiter/i)).toBeTruthy();
});

test("a plan that maps nobody cannot be applied", async () => {
  await preview({ ...PLAN, apply: [], propose: [] });
  expect(await screen.findByRole("button", { name: /Nothing to apply/i })).toBeTruthy();
});

test("a failed row is reported next to the ones that landed", async () => {
  automapRecruiterBitrixUsers.mockResolvedValueOnce(PLAN);
  render(<BitrixAutomapPanel />);
  fireEvent.click(matchButton());
  await screen.findByText(/Will map 1 recruiter/i);

  automapRecruiterBitrixUsers.mockResolvedValueOnce({
    ...PLAN,
    applied: [],
    failed: [{ recruiterId: 1, recruiterName: "Alex Smith", error: "duplicate key value" }],
  });
  fireEvent.click(applyButton());
  expect(await screen.findByText(/Alex Smith: duplicate key value/)).toBeTruthy();
});
