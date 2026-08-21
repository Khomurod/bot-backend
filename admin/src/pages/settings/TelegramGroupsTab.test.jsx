/**
 * Settings → Telegram Groups: the Driver Raise Review has TWO independent
 * destinations, and an admin must not be able to confuse them.
 *
 * ① Dispatch Rate Review — REQUESTS: the group that is asked to fill the review.
 * ② Driver Raise Results → ACCOUNTING: the group that receives the finished
 *    pay decision.
 *
 * These tests pin that both fields exist, load their own stored value, save
 * independently of each other, and that the UI says which is which — plus the
 * warning shown when both deliberately point at one group.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TelegramGroupsTab from "./TelegramGroupsTab";
import { getMessageGroupSettings, updateMessageGroupSettings } from "../../api";

vi.mock("../../api", () => ({
  getMessageGroupSettings: vi.fn(),
  updateMessageGroupSettings: vi.fn(),
}));

const entry = (groupId) => ({ groupId, fromEnv: false, configured: Boolean(groupId) });

function settings({ dispatchReview = "", raiseResults = "" } = {}) {
  return {
    mileageBonus: entry("-100111"),
    roadBonus: entry("-100222"),
    dispatchReview: entry(dispatchReview),
    raiseResults: entry(raiseResults),
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
}

const dispatchField = () => screen.getByLabelText(/Dispatch Rate Review — REQUESTS/);
const resultsField = () => screen.getByLabelText(/Driver Raise Results → ACCOUNTING/);

async function open(loaded = settings()) {
  getMessageGroupSettings.mockResolvedValue(loaded);
  updateMessageGroupSettings.mockImplementation(async (payload) => settings({
    dispatchReview: payload.dispatchReview,
    raiseResults: payload.raiseResults,
  }));
  render(<TelegramGroupsTab />);
  await waitFor(() => expect(dispatchField()).toBeInTheDocument());
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

test("both raise destinations are separate fields with their own stored value", async () => {
  await open(settings({ dispatchReview: "-100DISPATCH", raiseResults: "-100ACCT" }));
  expect(dispatchField()).toHaveValue("-100DISPATCH");
  expect(resultsField()).toHaveValue("-100ACCT");
  expect(dispatchField()).not.toBe(resultsField());
});

test("an unset accounting group is shown as not configured, never pre-filled from dispatch", async () => {
  await open(settings({ dispatchReview: "-100DISPATCH" }));
  expect(dispatchField()).toHaveValue("-100DISPATCH");
  expect(resultsField()).toHaveValue("");
  // One "✓ Configured" per configured category (mileage, road, dispatch) — the
  // accounting field is explicitly flagged as not configured.
  expect(screen.getAllByText(/✕ Not configured/)).toHaveLength(1);
});

test("saving sends both raise group IDs as separate, independent fields", async () => {
  await open(settings({ dispatchReview: "-100DISPATCH" }));
  fireEvent.change(resultsField(), { target: { value: " -100ACCT " } });
  fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

  await waitFor(() => expect(updateMessageGroupSettings).toHaveBeenCalledTimes(1));
  expect(updateMessageGroupSettings).toHaveBeenCalledWith({
    mileageBonus: "-100111",
    roadBonus: "-100222",
    dispatchReview: "-100DISPATCH", // untouched by editing the other field
    raiseResults: "-100ACCT",       // trimmed
  });
  await waitFor(() => expect(screen.getByText(/settings saved/i)).toBeInTheDocument());
  expect(resultsField()).toHaveValue("-100ACCT");
});

test("the accounting group can be changed without moving the dispatch group", async () => {
  await open(settings({ dispatchReview: "-100DISPATCH", raiseResults: "-100ACCT" }));
  fireEvent.change(resultsField(), { target: { value: "-100NEWACCT" } });
  fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

  await waitFor(() => expect(updateMessageGroupSettings).toHaveBeenCalledTimes(1));
  const payload = updateMessageGroupSettings.mock.calls[0][0];
  expect(payload.dispatchReview).toBe("-100DISPATCH");
  expect(payload.raiseResults).toBe("-100NEWACCT");
  await waitFor(() => expect(dispatchField()).toHaveValue("-100DISPATCH"));
});

test("the dispatch group can be cleared without clearing the accounting group", async () => {
  await open(settings({ dispatchReview: "-100DISPATCH", raiseResults: "-100ACCT" }));
  fireEvent.change(dispatchField(), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

  await waitFor(() => expect(updateMessageGroupSettings).toHaveBeenCalledTimes(1));
  const payload = updateMessageGroupSettings.mock.calls[0][0];
  expect(payload.dispatchReview).toBe("");
  expect(payload.raiseResults).toBe("-100ACCT");
});

test("the field descriptions say which direction each group is for", async () => {
  await open();
  // The request field talks about asking dispatch; the results field about the
  // finished decision going to accounting.
  expect(screen.getByText(/Where the bot ASKS FOR the review/)).toBeInTheDocument();
  expect(screen.getByText(/Where the bot SENDS THE ANSWER/)).toBeInTheDocument();
  expect(screen.getByText(/receives the finished pay decision/)).toBeInTheDocument();
});

test("using one group for both raise steps is allowed but warned about", async () => {
  await open(settings({ dispatchReview: "-100SHARED", raiseResults: "-100ACCT" }));
  expect(screen.queryByText(/point at the same group/)).not.toBeInTheDocument();

  fireEvent.change(resultsField(), { target: { value: "-100SHARED" } });
  await waitFor(() => expect(screen.getByText(/point at the same group/)).toBeInTheDocument());

  // Allowed: saving still goes through with the same ID in both.
  fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));
  await waitFor(() => expect(updateMessageGroupSettings).toHaveBeenCalledTimes(1));
  const payload = updateMessageGroupSettings.mock.calls[0][0];
  expect(payload.dispatchReview).toBe("-100SHARED");
  expect(payload.raiseResults).toBe("-100SHARED");
});
